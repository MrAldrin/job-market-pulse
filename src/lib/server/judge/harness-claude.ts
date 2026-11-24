import { Either, Schema } from "effect";
import { claudeModelAliases } from "../../contracts/reviewer-settings.ts";
import type { Reviewer } from "./reviewers.ts";
import type { CallOutcome } from "./harness.ts";
import { JsonObject, parseJsonInput, outcome } from "./harness-errors.ts";
import { redactedExcerpt } from "./diagnostics.ts";

export const claudeArgv = (executable: string, reviewer: Reviewer, system: string): string[] => [executable, "-p", "--model", reviewer.model, "--effort", reviewer.effort, "--system-prompt", system, "--tools", "", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--permission-prompts", "none", "--output-format", "json"];
const object = Schema.is(JsonObject);
const string = Schema.is(Schema.String);
const usage = Schema.is(Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(0n, 1_000_000n)));

function matchesModel(requested: string, reported: string): boolean {
  if (reported === requested || (reported.startsWith(`${requested}-`) && /^\d{8}$/.test(reported.slice(requested.length + 1)))) return true;

  if (!claudeModelAliases.some((alias) => alias === requested)) return false;

  const family = /^claude-(?:(?:\d+-)+)?(opus|sonnet|haiku)(?:-\d+)+$/.exec(reported)
    ?? /^claude-(?:\d+-)+(opus|sonnet|haiku)$/.exec(reported);

  return family?.[1] === requested;
}

export function interpretClaude(bytes: Uint8Array, reviewer: Reviewer, maxOutputTokens: number): CallOutcome {
  let textEnvelope: string;

  try { textEnvelope = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return outcome("unknown", "harness_output_invalid", "harness_error"); }

  const parsed = parseJsonInput(textEnvelope);

  if (Either.isLeft(parsed)) return outcome("unknown", "harness_output_invalid", "harness_error");
  const data = parsed.right;

  if (!object(data) || data.type !== "result") return outcome("unknown", "harness_output_invalid", "harness_error");
  const u = object(data.usage) ? data.usage : {};
  const parts = [];

  for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (Object.hasOwn(u, key)) parts.push(u[key]);
  }

  let sum = 0n;
  let valid = parts.length > 0;

  for (const part of parts) {
    if (usage(part)) sum += part;
    else valid = false;
  }

  const input_tokens = valid && usage(sum) ? Number(sum) : null;
  const output_tokens = usage(u.output_tokens) ? Number(u.output_tokens) : null;
  const text = string(data.result) ? data.result : "";
  const size = new TextEncoder().encode(text).length;
  const rawCost = data.total_cost_usd;
  const numericCost = Schema.is(Schema.Union(Schema.Number, Schema.BigIntFromSelf))(rawCost) ? Number(rawCost) : NaN;
  const cost = Number.isFinite(numericCost) && numericCost >= 0 ? numericCost : null;
  const diagnostics = { partial: false, stop_reason: string(data.stop_reason) ? data.stop_reason : null, answer_chars: [...text].length, answer_bytes: size, excerpt: redactedExcerpt(text), cost_usd: cost };
  const result = (status: CallOutcome["status"], code: string | null, branch: string): CallOutcome => ({ ...outcome(status, code, branch), input_tokens, output_tokens, text: status === "result" ? text : null, diagnostics: { ...diagnostics, branch } });

  if (data.is_error !== false || data.subtype !== "success") return result("unknown", "harness_call_error", "provider_unknown");
  const models = data.modelUsage;

  if (!object(models) || !Object.keys(models).length || !Object.keys(models).every((m) => matchesModel(reviewer.model, m))) return result("failed", "reported_model_mismatch", "model_mismatch");

  if ((Object.hasOwn(data, "num_turns") && data.num_turns !== 1n && data.num_turns !== 1 && data.num_turns !== true) || (Array.isArray(data.permission_denials) && data.permission_denials.length)) return result("failed", "unexpected_tool_call", "tool_call");

  if (data.stop_reason !== "end_turn") return result("failed", "invalid_model_response", "non_stop");

  if (!text) return result("failed", "invalid_model_response", "empty_text");

  if (size > 65536) return result("failed", "model_response_too_large", "response_size");

  if (output_tokens !== null && output_tokens > maxOutputTokens) return result("failed", "model_token_budget_exceeded", "token_budget");

  return result("result", null, "received");
}
