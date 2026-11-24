import { Effect, Schema } from "effect";
import { DisplayModelLabel } from "../../contracts/snapshot-settings.ts";
import type { StageInput } from "../../contracts/judge-state.ts";
import { AUTO_RETRY_ERROR_CODES, MAX_AUTO_RETRIES, PERMANENT_MODEL_UNKNOWN, REJUDGE_STAGE_VERSION } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { REJUDGE_PROMPT_VERSION } from "./prompts.ts";
import { decodeStored, sqlError, type JudgeSession } from "./session.ts";
import { decodeResult, readAttempt, ResultRow, type StoredStageResult } from "./stored.ts";

// A metadata-only carry-forward can create a new row for the same assessment.
// Link the second assessment to the original model result, not to that copy.
export const initialReviewOrigin = (session: JudgeSession, initial: StoredStageResult) => Effect.gen(function* () {
  const tables = yield* session.sql`SELECT 1 FROM sqlite_master WHERE name='review_result_contexts'`;

  if (!tables.length) return initial;

  const rows = yield* session.sql`WITH RECURSIVE origin(result_id) AS (
    VALUES (${initial.result_id}) UNION
    SELECT r.result_id FROM origin o JOIN review_result_contexts c ON c.result_id=o.result_id
    JOIN stage_results r ON r.result_id=json_extract(c.context_json,'$.reused_from_result_id')
    JOIN stage_attempts a ON a.attempt_id=r.attempt_id
    WHERE r.stage='full_review' AND r.stage_version<>${REJUDGE_STAGE_VERSION} AND r.listing_id=${initial.listing_id} AND a.profile_id=${session.profile_id}
  ) SELECT r.* FROM origin o JOIN stage_results r ON r.result_id=o.result_id ORDER BY r.rowid LIMIT 1`;

  return yield* decodeResult(yield* decodeStored(ResultRow, rows[0]));
}).pipe(Effect.mapError(sqlError));

export const savedRejudge = (session: JudgeSession, initial: StoredStageResult) => Effect.gen(function* () {
  const rows = yield* session.sql`SELECT r.* FROM stage_results r JOIN stage_attempts a ON a.attempt_id=r.attempt_id
    WHERE a.profile_id=${session.profile_id} AND a.status='completed' AND r.stage='full_review' AND r.stage_version=${REJUDGE_STAGE_VERSION}
    AND r.listing_id=${initial.listing_id} AND r.supersedes_result_id=${initial.result_id} ORDER BY r.recorded_at DESC,r.rowid DESC LIMIT 1`;

  return rows[0] ? yield* decodeResult(yield* decodeStored(ResultRow, rows[0])) : null;
}).pipe(Effect.mapError(sqlError));

export const validateRejudgeOrigin = (session: JudgeSession, input: StageInput, screenId: string | null) => Effect.gen(function* () {
  const rows = yield* session.sql`SELECT r.* FROM stage_results r JOIN stage_attempts a ON a.attempt_id=r.attempt_id
    WHERE a.profile_id=${session.profile_id} AND a.status='completed' AND r.stage='full_review' AND r.stage_version<>${REJUDGE_STAGE_VERSION}
    AND r.listing_id=${input.listing_id} AND r.source_version=${input.source_version} AND r.upstream_result_id=${screenId}
    ORDER BY r.recorded_at DESC,r.rowid DESC LIMIT 1`;

  if (!rows[0]) return yield* new JudgeStateError({ message: "Re-judge requires an accepted first assessment" });
  const first = yield* decodeResult(yield* decodeStored(ResultRow, rows[0]));
  const origin = yield* initialReviewOrigin(session, first);

  if (origin.result_id !== input.upstream_result_id) return yield* new JudgeStateError({ message: "Re-judge first assessment changed" });
});

// Guard the same assessment across regrouping, metadata copies and unrelated
// admission edits. New first scores or genuinely different ad text can proceed.
export const rejudgeAttemptBlock = (session: JudgeSession, input: StageInput) => Effect.gen(function* () {
  const rows = yield* session.sql<{ status: string; error_code: string | null }>`SELECT a.status,a.error_code
    FROM stage_attempt_candidates c JOIN stage_attempts a ON a.attempt_id=c.attempt_id
    WHERE a.profile_id=${session.profile_id} AND a.stage_version=${REJUDGE_STAGE_VERSION} AND a.prompt_version=${REJUDGE_PROMPT_VERSION}
    AND c.listing_id=${input.listing_id} AND c.upstream_result_id=${input.upstream_result_id}
    AND c.source_text_fingerprint IS ${input.source_text_fingerprint} AND a.call_count>0 ORDER BY a.rowid DESC`;

  const prior = rows[0];

  if (prior === undefined) return null;

  if (prior.status === "unknown" && prior.error_code !== "provider_temporary") return PERMANENT_MODEL_UNKNOWN;

  if (prior.status === "unknown" && prior.error_code === "provider_temporary") return null;

  if (prior.status === "failed" && prior.error_code !== null && AUTO_RETRY_ERROR_CODES.has(prior.error_code)
    && rows.filter((row) => row.status === "failed").length <= MAX_AUTO_RETRIES) return null;

  return "rejudge_attempts_blocked";
}).pipe(Effect.mapError(sqlError));

const safeLabel = Schema.is(DisplayModelLabel);

export const displayReviewModel = (provider: string | null, model: string | null): string | null => {
  if (!safeLabel(provider) || !safeLabel(model)) return null;

  const label = `${provider}/${model}`;

  return safeLabel(label) ? label : null;
};

export const reviewModelLabel = (session: JudgeSession, result: StoredStageResult) => Effect.gen(function* () {
  const { provenance: { provider_label, model_label } } = yield* readAttempt(session, result.attempt_id);

  return displayReviewModel(provider_label, model_label);
});
