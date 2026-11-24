import { Effect, Schema } from "effect";
import { checkProtocolAttempt, encodeProtocolLine, parseProtocolLine } from "./protocol.ts";
import { JudgeProtocolError } from "./protocol-errors.ts";
import { ReviewerError } from "./reviewer-errors.ts";
import { StoredJsonObject } from "./stored.ts";
import { WorkflowError } from "./workflow-errors.ts";
import { withReviewCounts } from "./workflow-progress.ts";
import { recordReviewReceipt, type ReviewEvent } from "./workflow-receipt.ts";
import { withReviewSession, type ReviewSessionOptions } from "./workflow-service.ts";

// B11 can bind this byte boundary to stdin/stdout. B10 does not start a CLI.
export interface ReviewProtocolIO {
  readonly readLine: Effect.Effect<Uint8Array | null, WorkflowError>;
  readonly writeLine: (line: Uint8Array) => Effect.Effect<void, WorkflowError>;
}

const failure = (code: string) => new WorkflowError({ code });
const safeCode = (error: Error): string => error instanceof WorkflowError || error instanceof JudgeProtocolError || error instanceof ReviewerError ? error.code : "workflow_blocked";

/** Serve one strict JSONL session while holding the selected profile lock. */
export const serveReviewSession = (options: ReviewSessionOptions, io: ReviewProtocolIO) => {
  const emit = (event: ReviewEvent) => encodeProtocolLine(event).pipe(Effect.flatMap(io.writeLine));

  const read = Effect.gen(function* () {
    const bytes = yield* io.readLine;

    if (bytes === null) return yield* failure("protocol_input_invalid");

    return yield* parseProtocolLine(bytes);
  });

  return withReviewSession(options, (session, store) => {
    let activeId: string | null = null;
    const counted = (event: ReviewEvent) => withReviewCounts(store, session, event).pipe(Effect.flatMap(emit));

    const run = Effect.gen(function* () {
      yield* emit(yield* session.configurationEvent());
      const ready = yield* session.start();
      yield* counted(ready);

      if (ready.type !== "ready") return ready.type === "complete" ? 0 : 2;

      while (true) {
        let action = yield* session.nextAction();
        yield* counted(action);

        if (action.type === "progress") continue;

        if (action.type === "complete") return 0;

        if (action.type === "budget_exhausted") {
          const message = yield* read;

          if (message.type === "supersede" && message.run_id === action.run_id && message.owner_confirmed) yield* counted(yield* session.supersedeRun(true));
          else yield* emit({ type: "paused", status: "partial" });

          return 0;
        }

        if (action.type === "retry_confirmation") {
          const message = yield* read;

          if (!("attempt_id" in message)) return yield* failure("protocol_attempt_mismatch");
          yield* checkProtocolAttempt(message, action.attempt_id);

          if (message.type === "skip_retry") {
            yield* counted(yield* session.skipRetry(action.attempt_id));
            continue;
          }

          if (message.type !== "retry") return yield* failure("protocol_retry_action_invalid");
          action = yield* session.confirmRetry(action.attempt_id);

          if (action.type === "progress") { yield* counted(action); continue; }

          yield* emit(action);
        }

        if (action.type !== "request") return yield* failure("protocol_action_invalid");
        const message = yield* read;

        if (!("attempt_id" in message)) return yield* failure("protocol_attempt_mismatch");
        yield* checkProtocolAttempt(message, action.attempt_id);

        if (message.type === "cancel_before_submit") { yield* emit(yield* session.cancelBeforeSubmit(action.attempt_id));

 return 0; }

        if (message.type !== "submit") return yield* failure("protocol_submit_invalid");
        const submitted = yield* session.submit(action.attempt_id, { harness_label: message.harness_label ?? "", provider_label: message.provider_label ?? "", model_label: message.model_label ?? "", reasoning_level: message.reasoning_level ?? "" });
        activeId = action.attempt_id;
        yield* emit(submitted);
        const response = yield* read;

        if (!("attempt_id" in response)) return yield* failure("protocol_attempt_mismatch");
        yield* checkProtocolAttempt(response, action.attempt_id);

        if (response.type !== "result" && response.type !== "unknown" && response.type !== "failed") return yield* failure("protocol_result_invalid");
        const metadata = yield* Schema.decodeUnknown(StoredJsonObject)(response.diagnostics ?? {}).pipe(Effect.mapError(() => failure("protocol_input_invalid")));

        const result = yield* recordReviewReceipt(store, session, action.attempt_id, { status: response.type, text: response.type === "result" ? response.raw_result : null,
          error_code: response.type === "result" ? null : response.error_code ?? null, input_tokens: response.input_tokens ?? null,
          output_tokens: response.output_tokens ?? null, wall_time_seconds: response.wall_time_seconds ?? null, diagnostics: metadata });

        activeId = null;
        yield* counted(result);
      }
    });

    return run.pipe(Effect.ensuring(Effect.suspend(() => activeId === null ? Effect.void : session.markUnknown(activeId, "pi_response_error").pipe(Effect.ignore))));
  }).pipe(Effect.catchAll((error) => emit({ type: "blocked", status: "blocked", error_code: safeCode(error) }).pipe(Effect.as(2))));
};
