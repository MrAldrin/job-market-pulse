import { Either, Schema } from "effect";
import type { Reviewer } from "./reviewers.ts";
import type { CallOutcome } from "./harness.ts";
import { JsonObject, parseJsonInput, outcome } from "./harness-errors.ts";

export const piArgv = (executable: string, reviewer: Reviewer, system: string): string[] => [executable, "--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline", "--approve", "--model", `${reviewer.provider}/${reviewer.model}`, "--thinking", reviewer.effort, "--system-prompt", system];
export const piAuthCheckArgv = (executable: string, reviewer: Pick<Reviewer, "provider" | "model">): string[] => [executable, "auth", "check", "--provider", reviewer.provider, "--model", reviewer.model, "--json", "--no-refresh"];
export const retryPattern = /"type"\s*:\s*"(?:auto_retry_start|summarization_retry_scheduled)"/;
const object = Schema.is(JsonObject);
const usage = Schema.is(Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(0n, 1_000_000n)));
const auth = ["auth", "login", "unauthorized", "forbidden", "401", "403", "api key", "api_key", "credential", "refresh token", "token refresh", "invalid_grant", "expired"];
const temporary = ["rate limit", "rate_limit", "overloaded", "service unavailable", "internal server error", "bad gateway", "gateway timeout", "timed out", "timeout", "econnreset", "etimedout", "enotfound", "network"];

export function interpretPi(bytes: Uint8Array, reviewer: Reviewer): CallOutcome {
  const events: JsonObject[] = [];
  let textEnvelope: string;

  try { textEnvelope = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return outcome("unknown", "harness_output_invalid", "harness_error"); }

  for (const line of textEnvelope.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseJsonInput(line);

    if (Either.isLeft(parsed) || !object(parsed.right)) return outcome("unknown", "harness_output_invalid", "harness_error");
    events.push(parsed.right);
  }

  if (events.some((e) => e.type === "auto_retry_start" || e.type === "summarization_retry_scheduled")) return outcome("unknown", "harness_call_error", "pi_auto_retry", true);
  const event = events.findLast((e) => e.type === "message_end" && object(e.message) && e.message.role === "assistant");

  if (!event || !object(event.message)) return outcome("unknown", "harness_output_invalid", "no_final_answer");
  const m = event.message; const u = object(m.usage) ? m.usage : {};
  const tokens = usage(u.input) && usage(u.output) ? { input_tokens: Number(u.input), output_tokens: Number(u.output) } : { input_tokens: null, output_tokens: null };
  const result = (status: CallOutcome["status"], code: string | null, branch: string): CallOutcome => ({ ...outcome(status, code, branch), ...tokens });

  if (m.stopReason === "error") {
    const error = String(m.errorMessage ?? "").toLowerCase();

    if (auth.some((s) => error.includes(s))) return result("unknown", "harness_call_error", "provider_auth");

    if (temporary.some((s) => error.includes(s)) || /\b5(?:00|02|03|04)\b/.test(error)) return result("unknown", "provider_temporary", "provider_temporary");

    return result("unknown", "harness_call_error", "provider_unknown");
  }

  if ((m.responseModel || m.model) !== reviewer.model) return result("failed", "reported_model_mismatch", "model_mismatch");
  let text = "";

  if (Array.isArray(m.content)) for (const block of m.content) {
    if (object(block) && block.type === "text") text += String(block.text ?? "");
  }

  if (m.stopReason !== "stop" || !text) return result("failed", "invalid_model_response", "non_stop");

  return { ...result("result", null, "received"), text, diagnostics: { branch: "received", partial: false, stop_reason: "stop" } };
}
