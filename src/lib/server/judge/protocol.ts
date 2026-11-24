import { Effect, Either, Schema } from "effect";
import { JudgeProtocolInput } from "../../contracts/judge-protocol.ts";
import type { PythonJson } from "../shared/python-json.ts";
import { JsonObject } from "../shared/json-input.ts";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { JudgeProtocolError } from "./protocol-errors.ts";

export const PROTOCOL_LINE_MAX_BYTES = 1_000_000;
const failure = (code: JudgeProtocolError["code"]) => new JudgeProtocolError({ code });

// Frozen input counts the optional terminator in its byte budget; output does not.
export const parseProtocolLine = (bytes: Uint8Array) => Effect.gen(function* () {
  const end = bytes.at(-1) === 10 ? bytes.length - 1 : bytes.length;
  const line = bytes.subarray(0, end);

  if (line.includes(10) || bytes.length > PROTOCOL_LINE_MAX_BYTES) return yield* failure("protocol_input_invalid");
  const parsed = parseStrictContractBytes(line, PROTOCOL_LINE_MAX_BYTES);

  if (Either.isLeft(parsed)) return yield* failure("protocol_input_invalid");

  return yield* Schema.decodeUnknown(JudgeProtocolInput, { onExcessProperty: "error" })(parsed.right).pipe(
    Effect.mapError(() => failure("protocol_input_invalid")),
  );
});

export const checkProtocolAttempt = <A extends { readonly attempt_id: string }>(message: A, expected: string) =>
  message.attempt_id === expected ? Effect.succeed(message) : Effect.fail(failure("protocol_attempt_mismatch"));

export const encodeProtocolLine = (value: Readonly<Record<string, PythonJson>>) => Effect.gen(function* () {
  const wire = yield* Schema.decodeUnknown(JsonObject)(value).pipe(Effect.mapError(() => failure("protocol_output_invalid")));
  const serialized = yield* Effect.try({ try: () => JSON.stringify(wire), catch: () => failure("protocol_output_invalid") });

  if (serialized === undefined || !serialized.isWellFormed()) return yield* failure("protocol_output_invalid");
  const bytes = new TextEncoder().encode(serialized);

  if (bytes.length > PROTOCOL_LINE_MAX_BYTES) return yield* failure("protocol_message_too_large");
  const line = new Uint8Array(bytes.length + 1);
  line.set(bytes);
  line[bytes.length] = 10;

  return line;
});

export type SkipAttempt = { readonly candidate_ids: readonly string[]; readonly status: string; readonly blocked_sub_reason?: string | null; readonly error_code?: string | null };

export type SkipCandidate = { readonly listing_id: string; readonly status: string };

export const countProtocolSkips = (candidates: readonly SkipCandidate[], skippedIds: ReadonlySet<string>, attempts: readonly SkipAttempt[]) => {
  const skipped = new Set(candidates.values().filter((candidate) => skippedIds.has(candidate.listing_id) && candidate.status !== "completed" && candidate.status !== "screened_out").map((candidate) => candidate.listing_id).toArray());
  const latest = new Map<string, SkipAttempt>();

  for (const attempt of attempts) for (const id of attempt.candidate_ids) if (skipped.has(id)) latest.set(id, attempt);
  const counts = { not_reviewed_count: skipped.size, skip_inactive_count: 0, skip_changed_count: 0, skip_text_count: 0, skip_failed_count: 0, skip_other_count: 0 };

  for (const id of skipped) {
    const attempt = latest.get(id);
    const code = attempt?.blocked_sub_reason || attempt?.error_code;

    if (code === "detail_inactive") counts.skip_inactive_count++;
    else if (["detail_mismatch", "detail_identity_mismatch", "source_version_changed"].includes(code ?? "")) counts.skip_changed_count++;
    else if (["detail_missing", "description_missing", "description_blank", "source_text_unavailable", "source_fetch_failed", "source_text_too_large"].includes(code ?? "")) counts.skip_text_count++;
    else if (attempt?.status === "failed" || attempt?.status === "unknown") counts.skip_failed_count++;
    else counts.skip_other_count++;
  }

  return counts;
};
