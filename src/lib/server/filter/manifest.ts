import { Either, Option, Schema } from "effect";
import { Candidate, CandidateManifest, ManifestCommon, type FitPreferences } from "../../contracts/filter.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { decodeStrict } from "../../contracts/support.ts";
import type { PersonalInputs } from "../profile/service.ts";
import { PythonFloat, codepointOrder, pythonJson, sha256, type PythonJson } from "../shared/python-json.ts";
import { FilterInputError } from "./errors.ts";
import { personalScreen, type ScreenContext } from "./screen-context.ts";

import { NEUTRAL_TITLE_EVIDENCE, type TitleEvidence } from "./title-evidence.ts";

export const MAX_SOURCE_ADS = 100_000;
export const MAX_ELIGIBLE_CANDIDATES = 10_000;
export const MAX_COVERAGE_BINDING_BYTES = 32_000_000;
export const MAX_JSON_BYTES = 2_000_000;
export const MAX_REVIEW_CANDIDATES = 120;
export const MAX_REVIEW_BATCHES = 100;
const invalid = (message: string) => new FilterInputError({ message });

const utcText = (micros: bigint): string => {
  const fraction = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const seconds = (micros - fraction) / 1_000_000n;
  const date = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);

  return date + (fraction === 0n ? "" : "." + fraction.toString().padStart(6, "0")) + "+00:00";
};

export interface ManifestOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly excludeIds?: ReadonlySet<string>;
  readonly candidateIds?: readonly string[];
}

// Numeric radius is a Python float in the manifest even when its settings hash
// retained an inherited integer. No other integer wire token changes identity.
export const manifestJson = (value: CandidateManifest, pretty = false, ascii = !pretty): string => pythonJson({
  ...value, candidates: value.candidates.map(candidateJson),
  fit_preferences: { ...value.fit_preferences, hard_limits: { ...value.fit_preferences.hard_limits, geography_radius_km: new PythonFloat(value.fit_preferences.hard_limits.geography_radius_km) } },
}, ascii, pretty);

// The frozen size cap uses json.dumps' default spaces and ensure_ascii=False,
// unlike the compact sorted representation used for identity hashes.
const manifestSize = (manifest: CandidateManifest): number => {
  const compact = manifestJson(manifest, false, false);

  let quoted = false;
  let escaped = false;
  let separators = 0;

  for (const character of compact) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ":" || character === ",") separators++;
  }

  return new TextEncoder().encode(compact).length + separators;
};

export const candidateJson = (candidate: Candidate): PythonJson => {
  const { geography_evidence_digest: digest, ...fields } = candidate;

  return digest === undefined ? fields : { ...fields, geography_evidence_digest: digest };
};

export const fitPreferences = (settings: PersonalInputs): Either.Either<FitPreferences, FilterInputError> => {
  const { preferences: prefs, filters, judge } = settings;
  const geography = filters.geography;

  if (judge.jobs?.preferred_terms === undefined) return Either.left(invalid("Personal preferred_terms must be explicit"));

  if (filters.jobs?.allowed_occupation_categories === undefined || !prefs.allowed_occupation_categories.length) return Either.left(invalid("Personal allowed_occupation_categories must be explicit and nonempty"));

  if (geography?.radius_km === undefined) return Either.left(invalid("Personal geography radius_km must be explicit"));

  if (!prefs.origin_source || prefs.origin_latitude === null || prefs.origin_longitude === null) return Either.left(invalid("Personal locality origin must be explicit"));

  return Either.right({
    preferred_terms: prefs.preferred_terms, allowed_occupation_categories: prefs.allowed_occupation_categories,
    preferred_municipalities: [], nearby_municipalities: [],
    excluded_title_terms: prefs.excluded_title_terms, excluded_employers: prefs.excluded_employers,
    excluded_municipalities: geography.excluded_municipalities === undefined ? [] : prefs.excluded_municipalities,
    hard_limits: { geography_radius_km: prefs.radius_km, geography_radius_is_explicit: true, geography_already_applied: true, exact_origin_included: false, other_constraints: "Use only constraints stated in the supplied profile; otherwise unknown." },
  });
};

export const manifestCommon = (profileId: string, settings: PersonalInputs, screen?: ScreenContext, evidence: TitleEvidence = NEUTRAL_TITLE_EVIDENCE): Either.Either<ManifestCommon, FilterInputError> => Either.flatMap(fitPreferences(settings), (preferences) => Either.mapLeft(decodeStrict(Schema.typeSchema(ManifestCommon))({
  schema_version: 1, profile_id: profileId, profile_fingerprint: settings.profile_fingerprint,
  preferences_fingerprint: settings.preference_fingerprint, rules_fingerprint: personalScreen(screen).rules_fingerprint,
  scoring_version: evidence.scoringVersion, fit_preferences: preferences,
}), () => invalid("Invalid manifest profile binding")));

export const sourceFreshness = (checkedAt: string, caughtUp: string, now: bigint, maxAge = 86_400_000_000n): Either.Either<void, FilterInputError> => {
  const checked = parseIsoTime(checkedAt);

  if (maxAge <= 0n) return Either.left(invalid("Positive freshness age required"));

  if (Option.isNone(checked) || !checked.value.aware) return Either.left(invalid("Invalid source check"));

  if (caughtUp !== "1") return Either.left(invalid("Feed is not caught up"));

  if (now < checked.value.epochMicros || now - checked.value.epochMicros > maxAge) return Either.left(invalid("Source check is stale or in the future"));

  return Either.right(undefined);
};

export const buildManifest = (common: ManifestCommon, candidates: readonly Candidate[], checkedAt: string, options: ManifestOptions = {}): Either.Either<CandidateManifest, FilterInputError> => {
  const limit = options.limit ?? MAX_REVIEW_CANDIDATES;
  const offset = options.offset ?? 0;
  const ids = options.candidateIds;
  const excluded = options.excludeIds ?? new Set<string>();

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REVIEW_CANDIDATES) return Either.left(invalid("Candidate limit must be between 1 and 120"));

  if (!Number.isSafeInteger(offset) || offset < 0) return Either.left(invalid("Candidate offset must be a nonnegative integer"));

  if (ids !== undefined && (offset !== 0 || ids.length > limit || new Set(ids).size !== ids.length)) return Either.left(invalid("Candidate-ID batch must be unique, within its cap and without offset"));

  if (candidates.length > MAX_ELIGIBLE_CANDIDATES) return Either.left(invalid("Filtered candidate count exceeds the absolute bound"));

  const checkedCommon = decodeStrict(Schema.typeSchema(ManifestCommon))(common);
  const checkedCandidates = decodeStrict(Schema.Array(Schema.typeSchema(Candidate)))(candidates);
  const checked = parseIsoTime(checkedAt);

  if (Either.isLeft(checkedCommon) || Either.isLeft(checkedCandidates) || Option.isNone(checked) || !checked.value.aware) return Either.left(invalid("Invalid manifest construction input"));

  if (new Set(candidates.map((item) => item.id)).size !== candidates.length) return Either.left(invalid("Duplicate candidate identity"));

  const ordered = [...candidates].sort((left, right) => codepointOrder(right.version, left.version) || codepointOrder(left.id, right.id));
  const pending = ordered.filter((item) => !excluded.has(item.id));
  const coverageBytes = pythonJson({ ...commonJsonRecord(common), candidates: [...ordered].sort((left, right) => codepointOrder(left.id, right.id)).map(candidateJson) });

  if (new TextEncoder().encode(coverageBytes).length > MAX_COVERAGE_BINDING_BYTES) return Either.left(invalid("Coverage binding exceeds the absolute size bound"));

  const coverageId = sha256(coverageBytes);
  const requested = ids === undefined ? undefined : new Set(ids);

  if (requested !== undefined && [...requested].some((id) => !ordered.some((item) => item.id === id))) return Either.left(invalid("Review does not match the current filtered source candidates"));

  const selected = requested === undefined ? pending.slice(offset, offset + limit) : ordered.filter((item) => requested.has(item.id));
  const binding = { ...commonJsonRecord(common), coverage_id: coverageId, candidates: selected.map(candidateJson) };

  const result: CandidateManifest = {
    ...common, coverage_id: coverageId, candidates: selected, manifest_id: sha256(pythonJson(binding)),
    checked_at: utcText(checked.value.epochMicros), caught_up: true, coverage: "Bounded NAV change-feed pool; excludes FINN-sourced ads.",
    eligible_count: ordered.length, reviewed_count: ordered.length - pending.length, candidate_count: selected.length,
    remaining_count: pending.length, candidate_offset: requested === undefined ? offset : null,
    batch_index: requested === undefined && pending.length ? Math.floor(offset / limit) + 1 : 0,
    batch_count: Math.ceil(pending.length / limit), batch_ids_fingerprint: sha256(pythonJson(selected.map((item) => item.id))),
    limit, truncated: pending.length > selected.length + offset,
  };

  if (manifestSize(result) > MAX_JSON_BYTES) return Either.left(invalid("Candidate manifest exceeds the absolute size bound"));

  return Either.right(result);
};

// This explicit record helper keeps the serializer typed without broad casts.
const commonJsonRecord = (common: ManifestCommon) => ({
  ...common,
  fit_preferences: { ...common.fit_preferences, hard_limits: { ...common.fit_preferences.hard_limits, geography_radius_km: new PythonFloat(common.fit_preferences.hard_limits.geography_radius_km) } },
});

export const buildManifestBatches = (common: ManifestCommon, candidates: readonly Candidate[], checkedAt: string, options: Omit<ManifestOptions, "offset" | "candidateIds"> = {}, maxBatches = MAX_REVIEW_BATCHES): Either.Either<readonly CandidateManifest[], FilterInputError> => {
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_REVIEW_BATCHES) return Either.left(invalid("Maximum batch count must be between 1 and 100"));

  return Either.flatMap(buildManifest(common, candidates, checkedAt, options), (first): Either.Either<readonly CandidateManifest[], FilterInputError> => {
    if (first.batch_count > maxBatches) return Either.left(invalid("Coverage needs more batches; use a larger limit up to 120"));

    const batches: CandidateManifest[] = [];

    for (let index = 0; index < first.batch_count; index++) {
      const next = buildManifest(common, candidates, checkedAt, { ...options, offset: index * first.limit });

      if (Either.isLeft(next)) return Either.left(next.left);
      batches.push(next.right);
    }

    return Either.right(batches);
  });
};
