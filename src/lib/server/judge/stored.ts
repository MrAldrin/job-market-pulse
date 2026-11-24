import { Array as EffectArray, Effect, Either, Predicate, Schema } from "effect";
import { Digest, Identity, RequestProvenance, ReviewStage, StageAttempt, StageInput } from "../../contracts/judge-state.ts";
import { awareTimestamp } from "../../contracts/support.ts";
import { PythonFloat, type PythonJson } from "../shared/python-json.ts";
import { JudgeStateError } from "./errors.ts";
import { decodeStored, requireInitialized, sqlError, type JudgeSession } from "./session.ts";
import { isoInstant, normalizeIdentity } from "./core.ts";

const isPythonJson = (value: unknown): value is PythonJson => value === null || Predicate.isString(value) || Predicate.isBoolean(value) || Predicate.isNumber(value) || Predicate.isBigInt(value) || value instanceof PythonFloat
  || (EffectArray.isArray(value) ? value.every(isPythonJson) : Predicate.isRecord(value) && Object.values(value).every(isPythonJson));

export const StoredJson = Schema.declare<PythonJson>(isPythonJson);

export const StoredJsonObject = Schema.declare<Readonly<Record<string, PythonJson>>>((value: unknown): value is Readonly<Record<string, PythonJson>> => Predicate.isRecord(value) && !(value instanceof PythonFloat) && isPythonJson(value));

const revive = <A>(_key: string, value: A, context?: { readonly source?: string }): A | bigint | PythonFloat => {
  if (!Predicate.isNumber(value) || !context?.source) return value;

  return /^-?[0-9]+$/.test(context.source) ? BigInt(context.source) : new PythonFloat(value);
};

// Decode the original own-key object, not a rebuilt Schema.Record. This is a JSON
// value check only; public review meaning belongs to its canonical boundary.
export const parseStoredJson = (text: string) => Either.gen(function* () {
  const raw = yield* Either.try({ try: () => JSON.parse(text, revive), catch: (cause) => new JudgeStateError({ message: "Stored JSON is invalid", cause }) });

  return yield* Either.mapLeft(Schema.decodeUnknownEither(StoredJson)(raw), (cause) => new JudgeStateError({ message: "Stored JSON value is invalid", cause }));
});

export const jsonProperty = (value: PythonJson, key: string): PythonJson | null =>
  Predicate.isRecord(value) && Object.hasOwn(value, key) ? value[key] ?? null : null;

const AttemptRow = Schema.Struct({
  ...StageAttempt.omit("candidate_ids", "provenance", "blocked_sub_reason").fields,
  ...RequestProvenance.fields,
  blocked_sub_reason: Schema.optional(Schema.NullOr(Schema.String)),
  submitted_at: Schema.optional(Schema.NullOr(awareTimestamp)),
  response_fingerprint: Schema.NullOr(Schema.String),
});

export const readAttempt = (session: JudgeSession, attemptId: string) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const selected = yield* normalizeIdentity(attemptId);
  const rows = yield* session.sql`SELECT * FROM stage_attempts WHERE attempt_id=${selected} AND profile_id=${session.profile_id}`;

  if (!rows[0]) return yield* new JudgeStateError({ message: "Unknown personal review attempt" });

  const row = yield* decodeStored(AttemptRow, rows[0]);
  const candidates = yield* session.sql`SELECT listing_id FROM stage_attempt_candidates WHERE attempt_id=${selected} ORDER BY listing_id`;
  const candidateIds = yield* decodeStored(Schema.Array(Schema.Struct({ listing_id: Identity })), candidates);

  return {
    attempt_id: row.attempt_id, run_id: row.run_id, profile_id: row.profile_id, stage: row.stage,
    status: row.status, input_fingerprint: row.input_fingerprint, manifest_id: row.manifest_id,
    stage_version: row.stage_version, prompt_version: row.prompt_version, attempt_number: row.attempt_number,
    retry_of_attempt_id: row.retry_of_attempt_id, requested_at: yield* isoInstant(row.requested_at),
    completed_at: row.completed_at === null ? null : yield* isoInstant(row.completed_at), error_code: row.error_code,
    candidate_ids: candidateIds.map((candidate) => candidate.listing_id),
    blocked_sub_reason: row.blocked_sub_reason ?? null,
    provenance: {
      provider_label: row.provider_label, model_label: row.model_label, reasoning_level: row.reasoning_level,
      call_count: row.call_count, request_bytes: row.request_bytes, response_bytes: row.response_bytes,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
    },
  } satisfies StageAttempt;
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const attemptInputs = (session: JudgeSession, attemptId: string) => Effect.gen(function* () {
  const identity = yield* normalizeIdentity(attemptId);
  const columns = yield* session.sql<{ name: string }>`PRAGMA table_info(stage_attempt_candidates)`;
  const provenance = columns.some((column) => column.name === "snapshot_provenance_json") ? "snapshot_provenance_json" : "NULL AS snapshot_provenance_json";
  const rows = yield* session.sql.unsafe(`SELECT listing_id,source_version,input_fingerprint,source_text_fingerprint,upstream_result_id,${provenance} FROM stage_attempt_candidates WHERE attempt_id=? ORDER BY listing_id`, [identity]);

  return yield* decodeStored(Schema.Array(StageInput), rows);
}).pipe(Effect.mapError(sqlError));

export const ResultRow = Schema.Struct({
  result_id: Identity,
  attempt_id: Identity,
  listing_id: Identity,
  stage: ReviewStage,
  source_version: Schema.String,
  input_fingerprint: Digest,
  result_fingerprint: Digest,
  stage_version: Schema.String,
  prompt_version: Schema.String,
  profile_fingerprint: Digest,
  preferences_fingerprint: Digest,
  rules_fingerprint: Digest,
  scoring_version: Schema.String,
  result_json: Schema.String,
  recorded_at: awareTimestamp,
  supersedes_result_id: Schema.NullOr(Identity),
  upstream_result_id: Schema.NullOr(Schema.String),
});

export interface StoredStageResult extends ResultValues {
  readonly value: PythonJson;
  readonly stale: boolean;
}

type ResultValues = Omit<typeof ResultRow.Type, "result_json">;

export const decodeResult = (raw: typeof ResultRow.Type): Effect.Effect<StoredStageResult, JudgeStateError> => Effect.gen(function* () {
  const { result_json, ...row } = raw;
  const value = yield* parseStoredJson(result_json);

  return { ...row, recorded_at: yield* isoInstant(row.recorded_at), value, stale: true };
});

export const resultsForAttempt = (session: JudgeSession, attemptId: string) => Effect.gen(function* () {
  const selected = yield* normalizeIdentity(attemptId);
  const rows = yield* session.sql`SELECT * FROM stage_results WHERE attempt_id=${selected} ORDER BY listing_id`;

  return yield* Effect.forEach(rows, (row) => decodeStored(ResultRow, row).pipe(Effect.flatMap(decodeResult)));
}).pipe(Effect.mapError(sqlError));
