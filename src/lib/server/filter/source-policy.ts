import { Context, Effect, Either, Layer, Predicate } from "effect";
import type { Preferences } from "../../contracts/profile-settings.ts";
import type { FilterSourcePolicy, SourceFilterSnapshot } from "../../contracts/source.ts";
import type { SourceAd } from "../../contracts/source-readers.ts";

import type { OwnedSettings } from "../profile/service.ts";
import { parseJsonInput, type JsonInput } from "../shared/json-input.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { assess, assessmentSortKey, type PreliminaryAssessment } from "./assessment.ts";
import { admissionAllowed } from "./candidate-filters.ts";
import { assessLocation, normalizeName, point, type AreaExtent, type GeoAssessment, type Point } from "./geography.ts";
import { manualScreen, type ScreenContext } from "./screen-context.ts";
import { FilterInputError, type FilterError } from "./errors.ts";
import { NEUTRAL_TITLE_EVIDENCE, type TitleEvidence } from "./title-evidence.ts";

export type { FilterSourcePolicy } from "../../contracts/source.ts";

export type { SourceAd } from "../../contracts/source-readers.ts";

// Structural Source seam. Source owns SQL, current-row reads, version CAS and
// scheduling. This module neither imports a Source implementation nor opens SQL.
export type SourceSnapshot = SourceFilterSnapshot;

export interface ScoredJob {
  readonly uuid: string; readonly title: string; readonly employer: string; readonly locations: readonly string[];
  readonly nav_url: string; readonly detail_missing: boolean; readonly source_changed_at: string;
  readonly assessment: PreliminaryAssessment; readonly geography: GeoAssessment;
}

// Operator reports use the full selected Profile radius, not the separate
// min(40 km, radius) current-admission ceiling. Future CLI composition passes
// this value explicitly; Source does not load another brick's settings file.
export const sourceReportRadius = (settings: OwnedSettings): number => settings.preferences.radius_km;

export interface ScoreOptions {
  readonly geography?: "all" | "inside" | "outside" | "unknown";
  readonly includeExcluded?: boolean;
  readonly offline?: boolean;
  readonly evidence?: TitleEvidence;
}

const invalid = () => new FilterInputError({ message: "Malformed saved Source scoring fields" });

const stringItems = (text: string): Either.Either<readonly string[], FilterInputError> => Either.gen(function* () {
  const raw = yield* Either.mapLeft(parseJsonInput(text), invalid);
  const items = Predicate.isString(raw) ? Array.from(raw) : Array.isArray(raw) ? raw : Predicate.isRecord(raw) ? Object.keys(raw) : null;

  if (items === null || !items.every(Predicate.isString)) return yield* Either.left(invalid());

  return items;
});

const rowAssessment = (row: SourceAd, preferences: Preferences, screen: ScreenContext, evidence: TitleEvidence) => Either.gen(function* () {
  const locations = yield* stringItems(row.locations);
  const topics = yield* stringItems(row.topics);

  return { locations, assessment: assess(row.title, row.employer, locations, [], topics, preferences, screen.excludeTitle, evidence) };
});

const canonicalUuid = (value: string): string | null => {
  const hex = value.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^[{}]+|[{}]+$/g, "").replaceAll("-", "");

  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const lower = hex.toLowerCase();

  return lower.slice(0, 8) + "-" + lower.slice(8, 12) + "-" + lower.slice(12, 16) + "-" + lower.slice(16, 20) + "-" + lower.slice(20);
};

export const sourcePoint = (value: JsonInput): Point | null => Array.isArray(value) && value.length === 2
  ? point(Predicate.isBigInt(value[0]) ? Number(value[0]) : value[0], Predicate.isBigInt(value[1]) ? Number(value[1]) : value[1]) : null;

export const scoreJobRowsWithCounts = (
  snapshot: SourceSnapshot, preferences: Preferences, screen: ScreenContext, areas: ReadonlyMap<string, AreaExtent>, options: ScoreOptions = {},
) => Either.gen(function* () {
  const origin = preferences.origin_source ? point(preferences.origin_latitude, preferences.origin_longitude) : null;
  const result: ScoredJob[] = [];

  let other = 0;
  let geographyFiltered = 0;

  for (const row of snapshot.ads) {
    const uuid = canonicalUuid(row.uuid);

    if (uuid === null) {
      other++;
      continue;
    }

    const { locations, assessment } = yield* rowAssessment(row, preferences, screen, options.evidence ?? NEUTRAL_TITLE_EVIDENCE);

    if (assessment.excluded_reason !== null && !options.includeExcluded) continue;
    const [rawPoints, incomplete] = snapshot.location_points[row.uuid] ?? [[], true];
    const points: Point[] = [];

    for (const raw of rawPoints) {
      const checked = sourcePoint(raw);

      if (checked !== null) points.push(checked);
    }

    const geography = assessLocation(origin, points, locations, preferences.radius_km, incomplete || points.length !== rawPoints.length, areas, normalizeName);

    if (options.geography !== undefined && options.geography !== "all" && options.geography !== geography.status) {
      geographyFiltered++;
      continue;
    }

    const unknowns = [...assessment.unknowns];

    if (row.detail_missing !== 0) unknowns.push("Details unavailable; summary fields only.");

    if (options.offline) unknowns.push("Offline snapshot may be stale; verify the listing on NAV.");
    result.push({
      uuid, title: row.title, employer: row.employer, locations, nav_url: "https://arbeidsplassen.nav.no/stillinger/stilling/" + uuid,
      detail_missing: row.detail_missing !== 0, source_changed_at: row.changed, assessment: { ...assessment, unknowns }, geography,
    });
  }

  result.sort((a, b) => {
    const excluded = Number(a.assessment.excluded_reason !== null) - Number(b.assessment.excluded_reason !== null);

    if (excluded) return excluded;
    const left = assessmentSortKey(a.assessment);
    const right = assessmentSortKey(b.assessment);

    return left[0] - right[0] || left[1] - right[1] || codepointOrder(a.uuid, b.uuid);
  });

  return { jobs: result, geographyFiltered, other };
});

export const scoreJobRows = (...args: Parameters<typeof scoreJobRowsWithCounts>): Either.Either<readonly ScoredJob[], FilterInputError> =>
  Either.map(scoreJobRowsWithCounts(...args), ({ jobs }) => jobs);

// Source confirms every callback is inside its existing Effect.try/filterOutput
// boundary, which tags and sanitizes failure. Only this synchronous seam unwraps
// an Either; the Filter core keeps expected failures explicit and never hides
// malformed SQL JSON behind an empty success result.
const forSource = <A>(result: Either.Either<A, FilterInputError>): A => Either.getOrThrowWith(result, (error) => error);

export class SourcePolicies extends Context.Tag("pulse/SourcePolicies")<SourcePolicies, {
  readonly fromSettings: (settings: OwnedSettings, areas: ReadonlyMap<string, AreaExtent>, selected?: ScreenContext, evidence?: TitleEvidence) => Effect.Effect<FilterSourcePolicy, FilterError>;
}>() {}

// Runtime callers use the owning contextual capability. The pure constructor
// remains available for core tests and owns the policy rules in one place.
export const SourcePoliciesLive = Layer.succeed(SourcePolicies, {
  fromSettings: (settings, areas, selected, evidence) => Effect.suspend(() => makeSourcePolicy(settings, areas, selected, evidence)),
});

export const makeSourcePolicy = (settings: OwnedSettings, areas: ReadonlyMap<string, AreaExtent>, selected?: ScreenContext, evidence: TitleEvidence = NEUTRAL_TITLE_EVIDENCE): Either.Either<FilterSourcePolicy, FilterError> => Either.map(manualScreen(settings, selected), (screen) => ({
  rankMissing: (ads) => forSource(Either.all(ads.map((row) => Either.map(rowAssessment(row, settings.preferences, screen, evidence), ({ assessment }) => ({ uuid: row.uuid, interest_score: assessment.signals.length }))))),
  locationCandidates: (snapshot) => forSource(Either.gen(function* () {
    const result: { readonly uuid: string }[] = [];

    for (const row of snapshot.ads) {
      const { assessment } = yield* rowAssessment(row, settings.preferences, screen, evidence);

      if (assessment.excluded_reason === null && admissionAllowed(row.title, snapshot.occupation_pairs[row.uuid] ?? [], settings.preferences)) result.push({ uuid: row.uuid });
    }

    return result;
  })),
  insideJobs: (snapshot) => forSource(Either.map(scoreJobRows(snapshot, settings.preferences, screen, areas, { geography: "inside", evidence }), (jobs) => jobs.map((job) => ({ uuid: job.uuid, source_changed_at: job.source_changed_at })))),
}));
