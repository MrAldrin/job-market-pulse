import { Effect, Either, Predicate, Schema } from "effect";
import { stageInputFingerprint, type CandidateProjection, type ManifestProjection } from "./inputs.ts";
import { reviewListingMaterial, reviewMaterialFingerprint, reviewTermsFingerprint } from "../filter/stage-fingerprint.ts";
import type { StoredStageResult } from "./stored.ts";
import { JudgeStateError } from "./errors.ts";
import { isoInstant, normalizeIdentity } from "./core.ts";
import { StoredJson, StoredJsonObject, parseStoredJson } from "./stored.ts";
import { decodeStored, sqlError, write, type JudgeSession } from "./session.ts";
import { pythonJson, type PythonJson } from "../shared/python-json.ts";
import { candidateJson } from "../filter/manifest.ts";

export interface ResultContextOptions {
  readonly reviewed_expiry?: string | null;
  readonly reviewed_detail_changed?: string | null;
  readonly reviewed_expiry_version?: 1 | null;
  readonly reused_from_result_id?: string | null;
  readonly review_material?: string;
  readonly review_source_material?: string;
  readonly review_terms?: string;
  readonly review_profile?: string;
  readonly review_prompt?: string;
}

// personal_history uses json.dumps' default separators for this one table.
// Change only punctuation outside strings, not punctuation in source metadata.
const contextJson = (value: PythonJson): string => {
  const compact = pythonJson(value, false);
  let quoted = false;
  let result = "";

  for (let index = 0; index < compact.length; index++) {
    const character = compact[index];
    result += character;

    if (quoted && character === "\\") result += compact[++index];
    else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === "," || character === ":")) result += " ";
  }

  return result;
};

export const saveResultContext = (session: JudgeSession, resultId: string, candidate: CandidateProjection, options: ResultContextOptions = {}) => Effect.gen(function* () {
  const identity = yield* normalizeIdentity(resultId);
  const source = candidateJson(candidate);
  const keys = ["id", "version", "title", "employer", "locations", "url", "expires_at", "detail_missing"];

  if (!Predicate.isRecord(source) || !keys.every((key) => Object.hasOwn(source, key))) {
    return yield* new JudgeStateError({ message: "Validated result candidate metadata is missing" });
  }

  const metadata = Object.fromEntries(keys.map((key) => [key, source[key] ?? null]));

  if (options.reviewed_expiry_version === 1) {
    metadata["expires_at"] = options.reviewed_expiry ?? null;
    metadata["reviewed_detail_changed"] = options.reviewed_detail_changed ?? null;
    metadata["reviewed_expiry_version"] = 1;
  }

  for (const key of ["reused_from_result_id", "review_material", "review_source_material", "review_terms", "review_profile", "review_prompt"] as const) {
    const value = options[key];

    if (value != null) metadata[key] = value;
  }

  yield* write(session, Effect.gen(function* () {
    yield* session.sql`CREATE TABLE IF NOT EXISTS review_result_contexts (
        result_id TEXT PRIMARY KEY REFERENCES stage_results(result_id),
        context_json TEXT NOT NULL
    )`;
    yield* session.sql`INSERT INTO review_result_contexts VALUES (${identity},${contextJson(metadata)})`;
  }));
});

export const savedResultContext = (session: JudgeSession, resultId: string) => Effect.gen(function* () {
  const exists = yield* session.sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_result_contexts'`;

  if (exists.length === 0) return null;

  const identity = yield* normalizeIdentity(resultId);
  const rows = yield* session.sql<{ context_json: string }>`SELECT context_json FROM review_result_contexts WHERE result_id=${identity}`;

  return rows[0] ? yield* parseStoredJson(rows[0].context_json) : null;
}).pipe(Effect.mapError(sqlError));

export const actualReviewContext = (result: Pick<StoredStageResult, "profile_fingerprint" | "prompt_version">, context: PythonJson) => {
  const fields = Predicate.isRecord(context) ? context : {};

  const origin = {
    review_profile: Predicate.isString(fields["review_profile"]) ? fields["review_profile"] : result.profile_fingerprint,
    review_prompt: Predicate.isString(fields["review_prompt"]) ? fields["review_prompt"] : result.prompt_version,
  };

  return Predicate.isString(fields["review_terms"]) ? { ...origin, review_terms: fields["review_terms"] } : origin;
};

export const olderReviewContext = (result: Pick<StoredStageResult, "profile_fingerprint" | "prompt_version">, context: PythonJson, manifest: ManifestProjection, prompt: string): boolean => {
  const actual = actualReviewContext(result, context);

  return actual.review_profile !== manifest.profile_fingerprint || actual.review_prompt !== prompt
    || ("review_terms" in actual && actual.review_terms !== reviewTermsFingerprint(manifest));
};

export const matchesReviewMaterial = (
  result: Pick<StoredStageResult, "stage" | "source_version" | "input_fingerprint" | "profile_fingerprint" | "preferences_fingerprint" | "rules_fingerprint" | "scoring_version" | "prompt_version" | "upstream_result_id">,
  context: PythonJson, manifest: ManifestProjection, candidate: CandidateProjection, text: string | null, snapshotId: string | null,
): boolean => {
  const material = reviewListingMaterial(candidate);

  if (Predicate.isRecord(context)) {
    if (Predicate.isString(context["review_material"])) return context["review_material"] === reviewMaterialFingerprint(material, text);

    // Legacy rows keep their original binding and audit history. The saved
    // display fields suffice for a same-source match under the narrower policy.
    if (result.source_version === candidate.version && Object.entries(material).every(([key, value]) =>
      Object.hasOwn(context, key) && pythonJson(context[key] ?? null) === pythonJson(value))) return true;
  }

  if (result.source_version !== candidate.version) return false;

  const original = { ...manifest, profile_fingerprint: result.profile_fingerprint, preferences_fingerprint: result.preferences_fingerprint,
    rules_fingerprint: result.rules_fingerprint, scoring_version: result.scoring_version };

  const expected = stageInputFingerprint(original, candidate, result.stage, result.prompt_version, text, snapshotId, result.upstream_result_id);

  return Either.isRight(expected) && expected.right === result.input_fingerprint;
};

export type HistoricalPayload = Readonly<Record<string, PythonJson>> & { readonly imported_at: string };

export const historicalRows = (session: JudgeSession): Effect.Effect<readonly HistoricalPayload[], JudgeStateError> => Effect.gen(function* () {
  const exists = yield* session.sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_review_results'`;

  if (exists.length === 0) return [];

  const rows = yield* session.sql<{ payload_json: string; imported_at: string }>`SELECT payload_json,imported_at FROM historical_review_results WHERE profile_id=${session.profile_id} ORDER BY result_id`;

  return yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
    const payload = yield* decodeStored(StoredJsonObject, yield* parseStoredJson(row.payload_json));

    return { ...payload, imported_at: row.imported_at };
  }));
}).pipe(Effect.mapError(sqlError));

export const historicalRow = (session: JudgeSession, resultId: string): Effect.Effect<HistoricalPayload | null, JudgeStateError> => Effect.gen(function* () {
  const exists = yield* session.sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_review_results'`;

  if (exists.length === 0) return null;

  const rows = yield* session.sql<{ payload_json: string; imported_at: string }>`SELECT payload_json,imported_at FROM historical_review_results WHERE result_id=${resultId} AND profile_id=${session.profile_id}`;

  if (!rows[0]) return null;

  const payload = yield* decodeStored(StoredJsonObject, yield* parseStoredJson(rows[0].payload_json));

  return { ...payload, imported_at: rows[0].imported_at };
}).pipe(Effect.mapError(sqlError));

// Private read projections, not validators for the removed import API. Frozen
// readers select these fields without rejecting other retained metadata.
const HistoricalFields = Schema.Struct({
  result_id: Schema.String,
  listing_id: Schema.String,
  source_version: Schema.String,
  input_fingerprint: Schema.String,
  result_fingerprint: Schema.String,
  profile_fingerprint: Schema.String,
  preferences_fingerprint: Schema.String,
  rules_fingerprint: Schema.String,
  scoring_version: Schema.String,
  value: StoredJson,
  provenance: StoredJson,
  imported_at: Schema.String,
});

type HistoricalValues = Omit<typeof HistoricalFields.Type, "imported_at">;

export interface HistoricalResult extends HistoricalValues {
  readonly stage: "historical_full_review";
  readonly stage_version: null;
  readonly prompt_version: null;
  readonly upstream_result_id: null;
  readonly recorded_at: string;
  readonly stale: true;
}

export const historicalResult = (session: JudgeSession, resultId: string): Effect.Effect<HistoricalResult | null, JudgeStateError> => Effect.gen(function* () {
  const row = yield* historicalRow(session, resultId);

  if (row === null) return null;

  const { imported_at, ...saved } = yield* Either.mapLeft(Schema.decodeUnknownEither(HistoricalFields, { onExcessProperty: "ignore" })(row), (cause) => new JudgeStateError({ message: "Historical result payload is invalid", cause }));

  return { ...saved, recorded_at: yield* isoInstant(imported_at), stage: "historical_full_review", stage_version: null, prompt_version: null, upstream_result_id: null, stale: true };
});

const DisplayMetadata = Schema.Struct({ title: Schema.String, employer: Schema.String });
const HistoricalContext = Schema.Struct({ listing_id: Schema.String, source_version: Schema.String, candidate: DisplayMetadata });
const StagedContext = Schema.Struct({ id: Schema.String, version: Schema.String, ...DisplayMetadata.fields });

export const resultContext = (session: JudgeSession, resultId: string) => Effect.gen(function* () {
  const selected = yield* normalizeIdentity(resultId);
  const history = yield* historicalRow(session, selected);

  if (history !== null) {
    const row = yield* Either.mapLeft(Schema.decodeUnknownEither(HistoricalContext, { onExcessProperty: "ignore" })(history), (cause) => new JudgeStateError({ message: "Historical result context is invalid", cause }));

    return { listing_id: row.listing_id, source_version: row.source_version, title: row.candidate.title, employer: row.candidate.employer, provenance: "Historical import; original manifest and artifact SHA-256 bound; model/prompt unknown" };
  }

  const saved = yield* savedResultContext(session, selected);

  if (saved === null) return null;

  const row = yield* Either.mapLeft(Schema.decodeUnknownEither(StagedContext, { onExcessProperty: "ignore" })(saved), (cause) => new JudgeStateError({ message: "Saved result context is invalid", cause }));
  const reused = Predicate.isRecord(saved) && Object.hasOwn(saved, "reused_from_result_id");

  return { listing_id: row.id, source_version: row.version, title: row.title, employer: row.employer, provenance: reused ? "Earlier assessment reused for matching ad text" : "Immutable metadata saved with validated staged result" };
});
