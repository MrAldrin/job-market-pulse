import { Effect, Schema } from "effect";
import { ReviewStage } from "../../contracts/judge-state.ts";
import { validateManifestContext, type ClaimOptions } from "./attempts.ts";
import { batchFingerprint, normalizeIdentity, PERMANENT_MODEL_UNKNOWN } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { readRun } from "./runs.ts";
import { decodeStored, requireInitialized, sqlError, type JudgeSession } from "./session.ts";
import { readAttempt } from "./stored.ts";

const selectedRun = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const selected = yield* normalizeIdentity(runId);
  const rows = yield* session.sql`SELECT 1 FROM review_runs WHERE run_id=${selected} AND profile_id=${session.profile_id}`;

  if (!rows[0]) return yield* new JudgeStateError({ message: "Unknown personal review run" });

  return selected;
});

export type AttemptLookupOptions = Pick<ClaimOptions, "stage" | "manifest" | "inputs" | "stage_version" | "prompt_version">;

export const latestAttemptForInputs = (session: JudgeSession, runId: string, options: AttemptLookupOptions) => Effect.gen(function* () {
  const run = yield* readRun(session, runId);
  yield* validateManifestContext(session, options.manifest, run.context);
  yield* decodeStored(ReviewStage, options.stage);
  const batch = batchFingerprint(options.stage, options.stage_version, options.prompt_version, options.inputs);
  const rows = yield* session.sql<{ attempt_id: string }>`SELECT attempt_id FROM stage_attempts WHERE profile_id=${session.profile_id} AND stage=${options.stage} AND input_fingerprint=${batch} ORDER BY rowid DESC LIMIT 1`;

  // The lookup crosses closed runs and preserves its supplied version labels.
  // It does not tighten them through claim-time label stripping or admission.
  return rows[0] ? yield* readAttempt(session, rows[0].attempt_id) : null;
}).pipe(Effect.mapError(sqlError));

type InputLookupOptions = Pick<AttemptLookupOptions, "stage" | "stage_version" | "prompt_version" | "inputs">;

// A deliberate retry still binds to a whole attempt. Preparing a different
// batch without submitting it does not supersede any saved model outcome.
export const hasMatchingPermanentUnknown = (session: JudgeSession, options: InputLookupOptions) => Effect.gen(function* () {
  if (!options.inputs.length) return false;
  yield* requireInitialized(session);
  const candidates = options.inputs.flatMap((item) => [item.listing_id, item.input_fingerprint]);

  const rows = yield* session.sql.unsafe(`WITH proposed(listing_id,input_fingerprint) AS (VALUES ${options.inputs.map(() => "(?,?)").join(",")})
    SELECT 1 FROM proposed p WHERE (
      SELECT CASE WHEN a.status='unknown' THEN a.error_code END
      FROM stage_attempt_candidates c JOIN stage_attempts a ON a.attempt_id=c.attempt_id
      WHERE a.profile_id=? AND a.stage=? AND a.stage_version=? AND a.prompt_version=?
        AND c.listing_id=p.listing_id AND c.input_fingerprint=p.input_fingerprint
        AND a.call_count>0
      ORDER BY a.rowid DESC LIMIT 1
    )=? LIMIT 1`, [...candidates, session.profile_id, options.stage, options.stage_version, options.prompt_version, PERMANENT_MODEL_UNKNOWN]);

  return rows.length !== 0;
}).pipe(Effect.mapError(sqlError));

export const runAttempts = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  const selected = yield* selectedRun(session, runId);
  const rows = yield* session.sql<{ attempt_id: string }>`SELECT attempt_id FROM stage_attempts WHERE run_id=${selected} ORDER BY requested_at,rowid`;

  return yield* Effect.forEach(rows, (row) => readAttempt(session, row.attempt_id));
}).pipe(Effect.mapError(sqlError));

export interface RunProgress {
  readonly run_id: string;
  readonly status: string;
  readonly eligible_count: number;
  readonly reused_count: number;
  readonly candidate_ids: readonly string[];
  readonly completed_count: number;
  readonly screened_out_count: number;
  readonly screened_count: number;
  readonly pending_count: number;
  readonly unknown_attempt_count: number;
  readonly failed_attempt_count: number;
  readonly blocked_attempt_count: number;
  readonly model_calls: number;
}

const FullReviewFirstFound = Schema.Struct({ listing_id: Schema.String, first_found_at: Schema.String });

// Saved full-review membership is not current admission or historical-import
// membership. Preserve the retained raw SQL MIN timestamp ordering.
export const readFullReviewFirstFound = (session: JudgeSession): Effect.Effect<readonly (typeof FullReviewFirstFound.Type)[], JudgeStateError> => Effect.gen(function* () {
  if (!session.initialized) return [];

  const rows = yield* session.sql`SELECT listing_id,MIN(recorded_at) AS first_found_at FROM stage_results WHERE stage='full_review' GROUP BY listing_id`;

  return yield* decodeStored(Schema.Array(FullReviewFirstFound), rows);
}).pipe(Effect.mapError(sqlError));

const StatusCount = Schema.Struct({ status: Schema.String, count: Schema.Number });
const Count = Schema.Tuple(Schema.Struct({ count: Schema.Number }));

export const runProgress = (session: JudgeSession, runId: string): Effect.Effect<RunProgress, JudgeStateError> => Effect.gen(function* () {
  const selected = yield* selectedRun(session, runId);
  const runs = yield* session.sql`SELECT status,candidate_count FROM review_runs WHERE run_id=${selected}`;
  const [run] = yield* decodeStored(Schema.Tuple(Schema.Struct({ status: Schema.String, candidate_count: Schema.Number })), runs);
  const candidates = yield* session.sql`SELECT status,COUNT(*) AS count FROM review_run_candidates WHERE run_id=${selected} GROUP BY status`;
  const attempts = yield* session.sql`SELECT status,COUNT(*) AS count FROM stage_attempts WHERE run_id=${selected} GROUP BY status`;
  const counts = new Map((yield* decodeStored(Schema.Array(StatusCount), candidates)).map((row) => [row.status, row.count]));
  const attemptCounts = new Map((yield* decodeStored(Schema.Array(StatusCount), attempts)).map((row) => [row.status, row.count]));
  const reused = yield* session.sql`SELECT COUNT(*) AS count FROM review_run_candidates c JOIN stage_results r ON r.result_id=c.full_result_id JOIN stage_attempts a ON a.attempt_id=r.attempt_id WHERE c.run_id=${selected} AND c.status='completed' AND (a.run_id<>c.run_id OR a.call_count=0)`;
  const [reuse] = yield* decodeStored(Count, reused);
  const rows = yield* session.sql`SELECT listing_id FROM review_run_candidates WHERE run_id=${selected} ORDER BY listing_id`;
  const identities = yield* decodeStored(Schema.Array(Schema.Struct({ listing_id: Schema.String })), rows);
  const calls = yield* session.sql`SELECT COALESCE(SUM(call_count),0) AS count FROM stage_attempts WHERE run_id=${selected}`;
  const [usage] = yield* decodeStored(Count, calls);

  return {
    run_id: selected, status: run.status, eligible_count: run.candidate_count,
    reused_count: reuse.count, candidate_ids: identities.map((row) => row.listing_id),
    completed_count: counts.get("completed") ?? 0,
    screened_out_count: counts.get("screened_out") ?? 0,
    screened_count: counts.get("screened") ?? 0,
    pending_count: counts.get("pending") ?? 0,
    unknown_attempt_count: attemptCounts.get("unknown") ?? 0,
    failed_attempt_count: attemptCounts.get("failed") ?? 0,
    blocked_attempt_count: attemptCounts.get("blocked") ?? 0,
    model_calls: usage.count,
  };
}).pipe(Effect.mapError(sqlError));
