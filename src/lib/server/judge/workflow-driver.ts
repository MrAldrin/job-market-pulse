import { Effect } from "effect";
import type { ReviewStage } from "../../contracts/judge-state.ts";
import { PERMANENT_MODEL_UNKNOWN } from "./core.ts";
import { ReviewerHarness } from "./harness.ts";
import type { Reviewer } from "./reviewers.ts";
import { withReviewCounts } from "./workflow-progress.ts";
import { recordReviewReceipt, type ReviewEvent } from "./workflow-receipt.ts";
import { withReviewSession, type ReviewSessionOptions } from "./workflow-service.ts";
import { WorkflowError } from "./workflow-errors.ts";

export interface ReviewDriverIO {
  readonly executableFor: (harness: Reviewer["harness"]) => Effect.Effect<string, WorkflowError>;
  readonly onEvent: (event: ReviewEvent) => Effect.Effect<void, WorkflowError>;
  readonly onBatch?: (stage: ReviewStage, count: number) => Effect.Effect<void>;
  readonly retry: (event: ReviewEvent) => Effect.Effect<"retry" | "skip" | "pause", WorkflowError>;
}

/** Explicit native harness entry. Configuration alone never starts a call. */
export const runReviewSession = (options: ReviewSessionOptions, io: ReviewDriverIO) => withReviewSession(options, (session, store) => {
  let activeId: string | null = null;
  const counted = (event: ReviewEvent) => withReviewCounts(store, session, event).pipe(Effect.tap(io.onEvent));

  const run = Effect.gen(function* () {
    const harness = yield* ReviewerHarness;
    yield* io.onEvent(yield* session.configurationEvent());
    const ready = yield* counted(yield* session.start());

    if (ready["type"] !== "ready") return ready;

    while (true) {
      let action = yield* session.nextAction();
      const event = yield* counted(action);

      if (action.type === "progress") continue;

      if (action.type === "complete") return event;

      if (action.type === "budget_exhausted") {
        if (options.reviewAll) yield* counted(yield* session.supersedeRun(true));

        return event;
      }

      if (action.type === "retry_confirmation") {
        const choice = yield* io.retry(action);

        if (choice === "pause") return yield* counted({ type: "paused", status: "partial", run_id: session.runId() });

        if (choice === "skip") { yield* counted(yield* session.skipRetry(action.attempt_id)); continue; }

        action = yield* session.confirmRetry(action.attempt_id);
        yield* counted(action);

        if (action.type === "progress") continue;
      }

      if (action.type !== "request") continue;
      const reviewer = session.reviewerFor(action.stage);
      const executable = yield* io.executableFor(reviewer.harness);
      const submitted = yield* session.submit(action.attempt_id, { harness_label: reviewer.harness, provider_label: reviewer.provider, model_label: reviewer.model, reasoning_level: reviewer.effort });
      activeId = action.attempt_id;
      yield* io.onEvent(submitted);
      yield* (io.onBatch?.(action.stage, action.candidate_count) ?? Effect.void);
      const receipt = yield* harness.call({ executable, reviewer, system_prompt: action.system_prompt, user_prompt: action.user_prompt, max_output_tokens: action.max_output_tokens });
      const recorded = yield* recordReviewReceipt(store, session, action.attempt_id, receipt, options.reviewAll);
      activeId = null;
      yield* counted(recorded);

      if (receipt.error_code === "provider_temporary") return yield* new WorkflowError({ code: "provider_temporary" });

      if (recorded["status"] === "unknown") return yield* new WorkflowError({ code: PERMANENT_MODEL_UNKNOWN });
    }
  });

  return run.pipe(Effect.ensuring(Effect.suspend(() => activeId === null ? Effect.void : session.markUnknown(activeId, "pi_response_error").pipe(Effect.ignore))));
});
