import { Effect } from "effect";
import type { PythonJson } from "../shared/python-json.ts";
import { diagnostic, recordAttemptDiagnostic } from "./diagnostics.ts";
import { finishModelCall } from "./model-log.ts";
import { PERMANENT_MODEL_UNKNOWN } from "./core.ts";
import type { JudgeDatabaseHandle } from "./database.ts";
import type { createReviewSession } from "./workflow-controller.ts";
import { WorkflowError } from "./workflow-errors.ts";

export type ReviewSession = Effect.Effect.Success<ReturnType<typeof createReviewSession>>;

export type ReviewEvent = Readonly<Record<string, PythonJson>>;

export interface ReviewReceipt {
  readonly status: "result" | "failed" | "unknown";
  readonly text: string | null;
  readonly error_code: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly wall_time_seconds: number | null;
  readonly diagnostics: Readonly<Record<string, PythonJson>>;
}

// A shell receipt owns telemetry. A direct recordResponse call does not.
export const recordReviewReceipt = (store: JudgeDatabaseHandle, session: ReviewSession, attemptId: string, receipt: ReviewReceipt, reviewAll = false) => Effect.gen(function* () {
  yield* finishModelCall(store, attemptId, receipt);
  const usage = { input_tokens: receipt.input_tokens, output_tokens: receipt.output_tokens, diagnostics: { ...receipt.diagnostics } };

  if (receipt.status !== "result") {
    const metadata = { ...receipt.diagnostics, input_tokens: receipt.input_tokens, output_tokens: receipt.output_tokens };
    yield* recordAttemptDiagnostic(store, attemptId, diagnostic({ metadata, branch: receipt.diagnostics["branch"] ?? "unknown" }));

    const unknownCode = reviewAll && receipt.error_code !== "provider_temporary" ? PERMANENT_MODEL_UNKNOWN : receipt.error_code ?? "pi_call_uncertain";

    return receipt.status === "unknown"
      ? yield* session.markUnknown(attemptId, unknownCode)
      : yield* session.markFailed(attemptId, receipt.error_code ?? "invalid_model_response", usage);
  }

  if (receipt.text === null) return yield* new WorkflowError({ code: "protocol_result_invalid" });

  return yield* session.recordResponse(attemptId, receipt.text, usage);
});
