import type { CallOutcome } from "./harness.ts";

export const outcome = (status: CallOutcome["status"], error_code: string | null, branch: string, partial = false): CallOutcome => ({
  status, text: null, error_code, input_tokens: null, output_tokens: null,
  wall_time_seconds: 0, diagnostics: { branch, partial },
});

// Envelope dictionaries stay open: provider metadata is not an answer contract.
// The shared parser preserves integer spellings so 1.0 cannot become token usage.
export { JsonObject, parseJsonInput } from "../shared/json-input.ts";
