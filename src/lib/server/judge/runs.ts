import { Effect, Either, Schema } from "effect";
import type { Candidate } from "../../contracts/filter.ts";
import { candidateJson } from "../filter/manifest.ts";
import { AttemptStatus, RunCandidate, RunContext, RunStatus, type RunRecord } from "../../contracts/judge-state.ts";
import { AUTO_RETRY_ERROR_CODES, MAX_AUTO_RETRIES, PERMANENT_MODEL_UNKNOWN, REJUDGE_STAGE_VERSION, fingerprint, finishedRunStatus, instant, isoInstant, isOpenRun, normalizeIdentity, utcText } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { JudgeIds, decodeStored, requireInitialized, sqlError, write, type JudgeSession } from "./session.ts";
import { pythonJson } from "../shared/python-json.ts";
import { strip } from "../shared/text.ts";

const RunRow = Schema.Struct({
  ...RunContext.fields,
  run_id: Schema.String,
  profile_id: Schema.String,
  status: RunStatus,
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
});

const CandidateBinding = Schema.Struct({ listing_id: Schema.String, source_version: Schema.String, candidate_fingerprint: Schema.String });

export const candidateBinding = (value: Candidate) => Either.gen(function* () {
  const identity = yield* normalizeIdentity(value.id);

  if (!strip(value.version)) return yield* Either.left(new JudgeStateError({ message: "Candidate source version is required" }));

  return { listing_id: identity, source_version: value.version, candidate_fingerprint: fingerprint(candidateJson(value)) };
});

const record = (row: typeof RunRow.Type): Either.Either<RunRecord, JudgeStateError> => Either.gen(function* () { return {
  run_id: row.run_id, profile_id: row.profile_id, status: row.status,
  context: {
    coverage_id: row.coverage_id, source_checked_at: row.source_checked_at,
    profile_fingerprint: row.profile_fingerprint, preferences_fingerprint: row.preferences_fingerprint,
    rules_fingerprint: row.rules_fingerprint, scoring_version: row.scoring_version,
    candidate_count: row.candidate_count, full_review_batch_size: row.full_review_batch_size,
  },
  started_at: yield* isoInstant(row.started_at), completed_at: row.completed_at === null ? null : yield* isoInstant(row.completed_at),
}; });

export const readRun = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const identity = yield* normalizeIdentity(runId);
  const columns = yield* session.sql<{ name: string }>`PRAGMA table_info(review_runs)`;
  const batch = columns.some((column) => column.name === "full_review_batch_size") ? "full_review_batch_size" : "5 AS full_review_batch_size";
  const rows = yield* session.sql.unsafe(`SELECT run_id,profile_id,coverage_id,source_checked_at,profile_fingerprint,preferences_fingerprint,rules_fingerprint,scoring_version,status,candidate_count,started_at,completed_at,${batch} FROM review_runs WHERE run_id=? AND profile_id=?`, [identity, session.profile_id]);

  if (!rows[0]) return yield* new JudgeStateError({ message: "Unknown personal review run" });

  return yield* record(yield* decodeStored(RunRow, rows[0]));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const runCandidates = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  const run = yield* readRun(session, runId);
  const rows = yield* session.sql`SELECT listing_id,source_version,candidate_fingerprint,status,screening_result_id,full_result_id FROM review_run_candidates WHERE run_id=${run.run_id} ORDER BY listing_id`;

  return yield* decodeStored(Schema.Array(RunCandidate), rows);
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const beginRun = (session: JudgeSession, context: RunContext, candidates: readonly Candidate[], now: bigint, runId: string | null = null, rereviewScope: string | null = null) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const checkedContext = yield* decodeStored(RunContext, context);
  const started = yield* utcText(now);

  if (candidates.length !== checkedContext.candidate_count) return yield* new JudgeStateError({ message: "Run candidates do not match the declared coverage" });

  const bindings = yield* Either.all(candidates.map(candidateBinding));

  if (new Set(bindings.map((candidate) => candidate.listing_id)).size !== bindings.length) {
    return yield* new JudgeStateError({ message: "Run candidates must be unique" });
  }

  const identity = runId === null ? yield* (yield* JudgeIds).next : yield* normalizeIdentity(runId);
  const checked = yield* instant(checkedContext.source_checked_at);
  const sourceCheck = (yield* utcText(checked)).replace(".000000+", "+");

  return yield* write(session, Effect.gen(function* () {
    const existing = yield* session.sql`SELECT run_id FROM review_runs WHERE run_id=${identity}`;

    if (existing.length > 0) {
      const saved = yield* readRun(session, identity);

      if (!isOpenRun(saved.status)) return yield* new JudgeStateError({ message: "Closed review run cannot be reopened" });

      if (saved.profile_id !== session.profile_id || pythonJson(saved.context) !== pythonJson(checkedContext)) {
        return yield* new JudgeStateError({ message: "Run ID is already bound to other inputs" });
      }

      const savedCandidates = yield* session.sql`SELECT listing_id,source_version,candidate_fingerprint FROM review_run_candidates WHERE run_id=${identity} ORDER BY listing_id`;
      const bound = yield* decodeStored(Schema.Array(CandidateBinding), savedCandidates);
      const sorted = [...bindings].sort((left, right) => left.listing_id.localeCompare(right.listing_id));

      if (pythonJson(bound) !== pythonJson(sorted)) return yield* new JudgeStateError({ message: "Run ID is already bound to other candidates" });

      return saved;
    }

    const open = yield* session.sql`SELECT run_id FROM review_runs WHERE profile_id=${session.profile_id} AND status IN ('pending','running','partial') LIMIT 1`;

    if (open.length > 0) return yield* new JudgeStateError({ message: "An open review run must be resumed or explicitly closed first" });

    yield* session.sql`INSERT INTO review_runs(run_id,profile_id,coverage_id,source_checked_at,profile_fingerprint,preferences_fingerprint,rules_fingerprint,scoring_version,status,candidate_count,started_at,completed_at,full_review_batch_size)
      VALUES (${identity},${session.profile_id},${checkedContext.coverage_id},${sourceCheck},${checkedContext.profile_fingerprint},${checkedContext.preferences_fingerprint},${checkedContext.rules_fingerprint},${checkedContext.scoring_version},'running',${checkedContext.candidate_count},${started},NULL,${checkedContext.full_review_batch_size})`;

    if (rereviewScope !== null) yield* session.sql`UPDATE review_runs SET rereview_scope=${rereviewScope} WHERE run_id=${identity}`;

    for (const candidate of bindings) {
      yield* session.sql`INSERT INTO review_run_candidates(run_id,listing_id,source_version,candidate_fingerprint,status,screening_result_id,full_result_id) VALUES (${identity},${candidate.listing_id},${candidate.source_version},${candidate.candidate_fingerprint},'pending',NULL,NULL)`;
    }

    return yield* readRun(session, identity);
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const resumeRun = (session: JudgeSession, runId: string, context: RunContext, candidates: readonly Candidate[]) => Effect.gen(function* () {
  const checked = yield* decodeStored(RunContext, context);
  const run = yield* readRun(session, runId);

  if (!isOpenRun(run.status)) return yield* new JudgeStateError({ message: "Review run is closed" });

  if (pythonJson(run.context) !== pythonJson(checked)) return yield* new JudgeStateError({ message: "Run source/profile context has changed" });

  const expected = yield* Either.all(candidates.map(candidateBinding));
  const actual = yield* session.sql`SELECT listing_id,source_version,candidate_fingerprint FROM review_run_candidates WHERE run_id=${run.run_id} ORDER BY listing_id`;
  const bindings = yield* decodeStored(Schema.Array(CandidateBinding), actual);
  const sorted = [...expected].sort((left, right) => left.listing_id.localeCompare(right.listing_id));

  if (pythonJson(bindings) !== pythonJson(sorted)) return yield* new JudgeStateError({ message: "Run candidate snapshot has changed" });

  return run;
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const readRereviewScope = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  const rows = yield* session.sql<{ rereview_scope: string | null }>`SELECT rereview_scope FROM review_runs WHERE profile_id=${session.profile_id} AND run_id=${runId}`;

  return rows[0]?.rereview_scope ?? null;
}).pipe(Effect.mapError(sqlError));

export const latestOpenRun = (session: JudgeSession) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const rows = yield* session.sql<{ run_id: string }>`SELECT run_id FROM review_runs WHERE profile_id=${session.profile_id} AND status IN ('pending','running','partial') ORDER BY started_at DESC,rowid DESC LIMIT 1`;

  return rows[0] ? yield* readRun(session, rows[0].run_id) : null;
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const closeRun = (session: JudgeSession, runId: string, terminalStatus: "stale" | "superseded", now: bigint, profileLockHeld: boolean, ownerConfirmed = false) => Effect.gen(function* () {
  yield* requireInitialized(session);

  yield* decodeStored(Schema.Literal("stale", "superseded"), terminalStatus);

  if (profileLockHeld !== true) return yield* new JudgeStateError({ message: "Profile lock confirmation is required to close a run" });

  if (terminalStatus === "superseded" && ownerConfirmed !== true) return yield* new JudgeStateError({ message: "Explicit owner confirmation is required to supersede" });

  const at = yield* utcText(now);

  return yield* write(session, Effect.gen(function* () {
    const run = yield* readRun(session, runId);

    if (run.status === terminalStatus) return run;

    if (!isOpenRun(run.status)) return yield* new JudgeStateError({ message: "Only an open review run can be closed" });

    yield* session.sql`UPDATE stage_attempts SET status='unknown',completed_at=${at},error_code='interrupted_unknown' WHERE run_id=${run.run_id} AND status='running'`;
    yield* session.sql`UPDATE stage_attempts SET status='blocked',completed_at=${at},error_code=${terminalStatus === "stale" ? "run_stale" : "run_superseded"} WHERE run_id=${run.run_id} AND status='pending'`;
    yield* session.sql`UPDATE review_runs SET status=${terminalStatus},completed_at=${at} WHERE run_id=${run.run_id}`;

    return yield* readRun(session, run.run_id);
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const finishRun = (session: JudgeSession, runId: string, now: bigint) => Effect.gen(function* () {
  const at = yield* utcText(now);

  return yield* write(session, Effect.gen(function* () {
    const run = yield* readRun(session, runId);

    if (!isOpenRun(run.status)) return yield* new JudgeStateError({ message: "Review run is already closed" });

    const counts = yield* session.sql<{ status: string; count: number }>`SELECT status,COUNT(*) AS count FROM review_run_candidates WHERE run_id=${run.run_id} GROUP BY status`;
    const byStatus = new Map(counts.map((row) => [row.status, row.count]));
    const attempts = yield* session.sql`SELECT status FROM stage_attempts WHERE run_id=${run.run_id}`;
    const checkedAttempts = yield* decodeStored(Schema.Array(Schema.Struct({ status: AttemptStatus })), attempts);
    const status = finishedRunStatus(run.context.candidate_count, byStatus.get("completed") ?? 0, byStatus.get("screened_out") ?? 0, checkedAttempts.map((row) => row.status));

    yield* session.sql`UPDATE review_runs SET status=${status},completed_at=${at} WHERE run_id=${run.run_id}`;

    return yield* readRun(session, run.run_id);
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const autoRetryListingIds = (session: JudgeSession) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const codes = [...AUTO_RETRY_ERROR_CODES].sort();

  const rows = yield* session.sql.unsafe<{ listing_id: string }>(`WITH ranked AS (
    SELECT sac.listing_id,sa.stage,sa.status,sa.error_code,ROW_NUMBER() OVER(PARTITION BY sac.listing_id ORDER BY sa.requested_at DESC,sa.attempt_number DESC,sa.rowid DESC) AS position
    FROM stage_attempt_candidates sac JOIN stage_attempts sa ON sa.attempt_id=sac.attempt_id WHERE sa.profile_id=? AND sa.stage_version<>?)
    SELECT ranked.listing_id FROM ranked WHERE ranked.position=1 AND ((ranked.status='unknown' AND COALESCE(ranked.error_code,'')<>?) OR (ranked.status='failed' AND ranked.error_code IN (${codes.map(() => "?").join(",")})))
    AND (SELECT COUNT(*) FROM stage_attempt_candidates c JOIN stage_attempts a ON a.attempt_id=c.attempt_id WHERE a.profile_id=? AND c.listing_id=ranked.listing_id AND a.stage=ranked.stage AND a.stage_version<>? AND a.status IN ('failed','unknown') AND COALESCE(a.error_code,'')<>?)<=?`, [session.profile_id, REJUDGE_STAGE_VERSION, PERMANENT_MODEL_UNKNOWN, ...codes, session.profile_id, REJUDGE_STAGE_VERSION, "provider_temporary", MAX_AUTO_RETRIES]);

  return new Set(rows.map((row) => row.listing_id));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

// A permanent unknown stays visible to selection. The controller refuses
// its exact prior inputs, not all future work for that listing.
export const retryBlockedListingIds = (session: JudgeSession) => Effect.gen(function* () {
  yield* requireInitialized(session);

  const rows = yield* session.sql<{ listing_id: string }>`WITH latest AS (
    SELECT sac.listing_id,sa.status,sa.error_code,ROW_NUMBER() OVER(PARTITION BY sac.listing_id ORDER BY sa.requested_at DESC,sa.attempt_number DESC,sa.rowid DESC) AS position
    FROM stage_attempt_candidates sac JOIN stage_attempts sa ON sa.attempt_id=sac.attempt_id WHERE sa.profile_id=${session.profile_id} AND sa.stage_version<>${REJUDGE_STAGE_VERSION})
    SELECT listing_id FROM latest WHERE position=1 AND status IN ('failed','blocked','unknown') AND COALESCE(error_code,'') NOT IN ('provider_temporary',${PERMANENT_MODEL_UNKNOWN})`;

  const automatic = yield* autoRetryListingIds(session);

  return new Set(rows.map((row) => row.listing_id).filter((identity) => !automatic.has(identity)));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));
