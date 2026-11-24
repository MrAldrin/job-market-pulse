import { packageConfigPath } from "../shared/paths.ts";
import { Clock, Context, Effect, Either, Layer, Option } from "effect";
import type { Candidate, CandidateManifest } from "../../contracts/filter.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import type { PersonalInputs } from "../profile/service.ts";
import { admissionAllowed, occupationLabels } from "./candidate-filters.ts";
import { FilterInputError } from "./errors.ts";
import type { AreaExtent, GeographyError } from "./geography.ts";
import { GeographyAreas } from "./geography-service.ts";
import { buildManifest, buildManifestBatches, manifestCommon, MAX_ELIGIBLE_CANDIDATES, MAX_SOURCE_ADS, sourceFreshness, type ManifestOptions } from "./manifest.ts";
import { personalScreen, type ScreenContext } from "./screen-context.ts";
import { scoreJobRowsWithCounts, type SourceSnapshot } from "./source-policy.ts";
import { NEUTRAL_TITLE_EVIDENCE, type TitleEvidence } from "./title-evidence.ts";

export interface ManifestSourceSnapshot extends SourceSnapshot {
  readonly listing_count: number;
  readonly checked_at: string;
  readonly caught_up: string;
  readonly location_binding_digests: Readonly<Record<string, string>>;
}

export interface FilterOptions extends ManifestOptions {
  readonly screen?: ScreenContext;
  readonly evidence?: TitleEvidence;
  readonly maxAgeMicros?: bigint;
}

export const prepareCandidates = (
  snapshot: ManifestSourceSnapshot, settings: PersonalInputs, areas: ReadonlyMap<string, AreaExtent>, now: bigint, screen: ScreenContext = personalScreen(),
  evidence: TitleEvidence = NEUTRAL_TITLE_EVIDENCE,
) => Either.gen(function* () {
  if (snapshot.listing_count > MAX_SOURCE_ADS) return yield* Either.left(new FilterInputError({ message: "Source listing count exceeds the absolute bound" }));
  const { jobs, geographyFiltered, other } = yield* scoreJobRowsWithCounts(snapshot, settings.preferences, screen, areas, { geography: "inside", includeExcluded: true, evidence });
  const source = new Map(snapshot.ads.map((row) => [row.uuid, row]));
  const candidates: Candidate[] = [];
  const filters = { pool: snapshot.ads.length, area: geographyFiltered, exclusions: 0, occupation: 0, other };

  for (const job of jobs) {
    const row = source.get(job.uuid);

    if (row === undefined) return yield* Either.left(new FilterInputError({ message: "Scored candidate has no matching Source row" }));

    if (job.assessment.excluded_reason !== null) {
      filters.exclusions++;
      continue;
    }

    if (row.expires !== null) {
      const expiry = parseIsoTime(row.expires);

      if (Option.isNone(expiry) || !expiry.value.aware) return yield* Either.left(new FilterInputError({ message: "Invalid expiry timestamp" }));

      if (expiry.value.epochMicros <= now) {
        filters.other++;
        continue;
      }
    }

    const pairs = snapshot.occupation_pairs[job.uuid] ?? [];

    if (!admissionAllowed(job.title, pairs, settings.preferences)) {
      filters.occupation++;
      continue;
    }

    if (candidates.length >= MAX_ELIGIBLE_CANDIDATES) return yield* Either.left(new FilterInputError({ message: "Filtered candidate count exceeds the absolute bound" }));

    const candidate = {
      id: job.uuid, version: job.source_changed_at, title: job.title, employer: job.employer, locations: job.locations,
      url: job.nav_url, expires_at: row.expires, detail_missing: job.detail_missing, geography: "inside" as const,
      geography_reason: job.geography.reason, occupation_categories: occupationLabels(pairs),
    };

    const digest = snapshot.location_binding_digests[job.uuid];
    candidates.push(digest === undefined ? candidate : { ...candidate, geography_evidence_digest: digest });
  }

  return { candidates, filters };
});

export const eligibleCandidates = (...args: Parameters<typeof prepareCandidates>): Either.Either<readonly Candidate[], FilterInputError> =>
  Either.map(prepareCandidates(...args), ({ candidates }) => candidates);

// Source supplies its validated current snapshot. No alternate SQLite reader or
// private Judge resource is created here. Test Layers use recorded Source facts.
export class FilterSource extends Context.Tag("pulse/FilterSource")<FilterSource, {
  readonly read: (now: bigint) => Effect.Effect<ManifestSourceSnapshot, FilterInputError>;
}>() {}

export class FilterResources extends Context.Tag("pulse/FilterResources")<FilterResources, {
  readonly areaExtentsPath: string;
}>() {}

export const FilterSourcePackageResources = Layer.succeed(FilterResources, {
  areaExtentsPath: packageConfigPath(import.meta.url, "area_extents.json"),
});

export class FilterManifests extends Context.Tag("pulse/FilterManifests")<FilterManifests, {
  readonly build: (profileId: string, settings: PersonalInputs, options?: FilterOptions) => Effect.Effect<CandidateManifest, FilterInputError | GeographyError>;
  readonly batches: (profileId: string, settings: PersonalInputs, options?: FilterOptions, maxBatches?: number) => Effect.Effect<readonly CandidateManifest[], FilterInputError | GeographyError>;
}>() {}

export const FilterManifestsLive = Layer.effect(FilterManifests, Effect.gen(function* () {
  const source = yield* FilterSource;
  const geography = yield* GeographyAreas;
  const resources = yield* FilterResources;

  const prepare = (profileId: string, settings: PersonalInputs, options: FilterOptions) => Effect.gen(function* () {
    const common = yield* manifestCommon(profileId, settings, options.screen, options.evidence);
    const now = BigInt(yield* Clock.currentTimeMillis) * 1000n;
    const snapshot = yield* source.read(now);

    if (snapshot.listing_count > MAX_SOURCE_ADS) return yield* Effect.fail(new FilterInputError({ message: "Source listing count exceeds the absolute bound" }));
    yield* sourceFreshness(snapshot.checked_at, snapshot.caught_up, now, options.maxAgeMicros);
    const areas = yield* geography.load(resources.areaExtentsPath);
    const candidates = yield* eligibleCandidates(snapshot, settings, areas, now, personalScreen(options.screen), options.evidence);

    return { common, snapshot, candidates };
  });

  return {
    build: (profileId, settings, options = {}) => prepare(profileId, settings, options).pipe(Effect.flatMap(({ common, snapshot, candidates }) => buildManifest(common, candidates, snapshot.checked_at, options))),
    batches: (profileId, settings, options = {}, maxBatches) => prepare(profileId, settings, options).pipe(Effect.flatMap(({ common, snapshot, candidates }) => buildManifestBatches(common, candidates, snapshot.checked_at, options, maxBatches))),
  };
}));
