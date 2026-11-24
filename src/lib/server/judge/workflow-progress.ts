import { Effect, Predicate } from "effect";
import type { JudgeDatabaseHandle } from "./database.ts";
import { countProtocolSkips } from "./protocol.ts";
import { runCandidates } from "./runs.ts";
import { runAttempts, runProgress } from "./views.ts";
import type { ReviewEvent, ReviewSession } from "./workflow-receipt.ts";

export const withReviewCounts = (store: JudgeDatabaseHandle, session: ReviewSession, event: ReviewEvent) => Effect.gen(function* () {
  const runId = session.runId() ?? (Predicate.isString(event["run_id"]) ? event["run_id"] : null);

  if (runId === null) return event;
  const progress = yield* runProgress(store, runId);
  const counts = countProtocolSkips(yield* runCandidates(store, runId), session.skippedCandidateIds(), yield* runAttempts(store, runId));

  return { ...event, ...counts, reused_count: progress.reused_count, completed_count: progress.completed_count,
    screened_out_count: progress.screened_out_count, blocked_attempt_count: progress.blocked_attempt_count,
    pending_count: progress.pending_count, candidate_count: progress.candidate_ids.length };
});
