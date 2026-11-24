import { Effect, Either, Predicate } from "effect";
import type { JsonInput } from "../shared/json-input.ts";
import { parseJsonInput } from "../shared/json-input.ts";
import { PythonFloat, pythonJson, type PythonJson } from "../shared/python-json.ts";
import { normalizeIdentity } from "./core.ts";
import { decodeStored, sqlError, write, type JudgeSession } from "./session.ts";
import { StoredJsonObject, parseStoredJson } from "./stored.ts";

const MAX_EXCERPT_BYTES = 4096;

const KEYS = new Set([
  "schema_version", "profile_id", "manifest_id", "assessed_at", "complete", "assessments",
  "id", "version", "outcome", "reason", "fit", "evidence", "uncertainties",
  "hard_constraints", "ad_text_reviewed",
]);

const ENUMS = new Set(["screened_out", "advance_to_full_review", "exceptional", "strong", "possible", "poor", "unknown", "pass", "fail"]);

const STOPS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred", "pending", "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]);

const BRANCHES = new Set([
  "received", "accepted", "usage_invalid", "response_size", "token_budget", "json_parse",
  "source_manifest", "source_binding", "validation", "persistence", "non_stop", "empty_text",
  "tool_call", "stream_limit", "stream_exception", "provider_unknown", "model_mismatch",
  "cost_budget", "timeout", "harness_error", "unknown",
]);

const CHECKS = new Map([
  ["Unexpected review schema", "review_schema"],
  ["Unexpected title-screen schema", "screen_schema"],
  ["Review does not match current profile and source manifest", "review_binding"],
  ["Screening does not match current profile and manifest", "screen_binding"],
  ["Missing or extra candidate assessments", "review_candidate_count"],
  ["Missing or extra title-screen assessments", "screen_candidate_count"],
  ["Unexpected candidate assessment fields", "review_candidate_fields"],
  ["Unexpected title-screen assessment fields", "screen_candidate_fields"],
  ["Unknown or repeated candidate identity", "review_candidate_identity"],
  ["Unknown or repeated title-screen candidate", "screen_candidate_identity"],
  ["Invalid personal-fit verdict", "fit_enum"],
  ["Invalid title-screen outcome", "screen_outcome_enum"],
  ["Title-screen reason must be bounded and nonempty", "screen_reason"],
  ["Each assessment requires a short evidence-based reason", "review_reason"],
  ["Hard constraints must be pass, fail or unknown", "hard_constraints_enum"],
  ["Invalid evidence list", "evidence_list"],
  ["Invalid uncertainties list", "uncertainties_list"],
  ["Ad-text evidence flag must be boolean", "ad_text_boolean"],
  ["Strong/exceptional fit requires reviewed ad text and source details", "strong_evidence"],
  ["Exceptional fit requires passed hard constraints and no unresolved uncertainty", "exceptional_evidence"],
  ["Review must explicitly cover the complete supplied pool", "review_complete"],
  ["Title screening must explicitly cover its complete batch", "screen_complete"],
  ["Manifest source state is stale, future or incomplete", "manifest_freshness"],
  ["Candidate expired; rebuild the current source manifest", "candidate_expired"],
  ["Assessment must follow source check and not be in future", "review_time"],
  ["Screening must follow source check and not be in future", "screen_time"],
  ["Duplicate JSON field", "duplicate_json_field"],
  ["JSON input must be an object", "json_object"],
  ["Excessively nested review JSON", "json_depth"],
  ["Invalid or excessively nested review JSON", "json_syntax"],
]);

const VALID_CHECKS = new Set([...CHECKS.values(), "validator_other", "json_constant", "assessment_timestamp"]);

export const validatorCode = (error: Error): string => {
  if (error.message.startsWith("Invalid JSON constant:")) return "json_constant";

  if (["assessment time must be an aware timestamp", "assessment time must include timezone", "Invalid assessment time"].includes(error.message)) return "assessment_timestamp";

  return CHECKS.get(error.message) ?? "validator_other";
};

const count = (value: PythonJson | undefined): number | null => {
  if (Predicate.isBigInt(value)) return value >= 0n && value <= 1_000_000_000n ? Number(value) : null;

  return Predicate.isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
};

const cost = (value: PythonJson | undefined): PythonFloat | null => {
  const number = value instanceof PythonFloat ? value.value : Predicate.isBigInt(value) ? Number(value) : value;

  return Predicate.isNumber(number) && Number.isFinite(number) && number >= 0 && number <= 10_000 ? new PythonFloat(number) : null;
};

const mask = (value: JsonInput, depth = 0, key = ""): JsonInput => {
  if (depth > 16) return "[DEPTH]";

  if (Array.isArray(value)) return value.slice(0, 32).map((item) => mask(item, depth + 1, key));

  if (Predicate.isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 64).map(([name, item], index) => [KEYS.has(name) ? name : `[KEY_${index}]`, mask(item, depth + 1, name)]));

  if (value === null || Predicate.isBoolean(value)) return value;

  if (Predicate.isString(value) && ["outcome", "fit", "hard_constraints"].includes(key) && ENUMS.has(value)) return value;

  return "[REDACTED]";
};

export const redactedExcerpt = (text: string): string => {
  if (new TextEncoder().encode(text).byteLength > 65536) return "[REDACTED oversized text]";

  // Masked keys, enum values and markers are all ASCII. Native serialization
  // preserves their insertion order; the sorted store serializer is not used.
  return Either.getOrElse(Either.map(parseJsonInput(text), (value) => JSON.stringify(mask(value)).slice(0, MAX_EXCERPT_BYTES)), () => "[REDACTED malformed/prose text]");
};

export interface DiagnosticOptions {
  readonly text?: string | null;
  readonly metadata?: PythonJson;
  readonly branch?: PythonJson;
  readonly check?: PythonJson;
}

export type Diagnostic = {
  readonly branch: string;
  readonly validation_check: string | null;
  readonly stop_reason: string | null;
  readonly answer_chars: number | null;
  readonly answer_bytes: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost_usd: PythonFloat | null;
  readonly partial: boolean;
  readonly excerpt: string;
};

export const diagnostic = (options: DiagnosticOptions = {}): Diagnostic => {
  const data = Predicate.isRecord(options.metadata) ? options.metadata : null;
  const field = (key: string): PythonJson | undefined => data !== null && Object.hasOwn(data, key) ? data[key] : undefined;
  const stop = field("stop_reason");
  const excerpt = field("excerpt");
  const text = options.text ?? null;

  return {
    branch: Predicate.isString(options.branch) && BRANCHES.has(options.branch) ? options.branch : "unknown",
    validation_check: Predicate.isString(options.check) && VALID_CHECKS.has(options.check) ? options.check : null,
    stop_reason: Predicate.isString(stop) && STOPS.has(stop) ? stop : null,
    answer_chars: text === null ? count(field("answer_chars")) : Array.from(text).length,
    answer_bytes: text === null ? count(field("answer_bytes")) : new TextEncoder().encode(text).byteLength,
    input_tokens: count(field("input_tokens")),
    output_tokens: count(field("output_tokens")),
    cost_usd: cost(field("cost_usd")),
    partial: field("partial") === true,
    excerpt: text !== null ? redactedExcerpt(text) : Predicate.isString(excerpt) ? redactedExcerpt(excerpt) : "[REDACTED unavailable text]",
  };
};

export const recordAttemptDiagnostic = (session: JudgeSession, attemptId: string, payload: Readonly<Record<string, PythonJson>>) => Effect.gen(function* () {
  // Re-sanitize independently, even when a caller used the canonical builder.
  const safe = diagnostic({ metadata: payload, branch: payload["branch"] ?? "unknown", check: payload["validation_check"] ?? null });

  yield* write(session, Effect.gen(function* () {
    const identity = yield* normalizeIdentity(attemptId);
    yield* session.sql`INSERT INTO attempt_diagnostics VALUES (${identity},${pythonJson(safe)}) ON CONFLICT(attempt_id) DO UPDATE SET payload_json=excluded.payload_json`;
  }));
}).pipe(Effect.mapError(sqlError));

export const attemptDiagnostic = (session: JudgeSession, attemptId: string) => Effect.gen(function* () {
  const tables = yield* session.sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempt_diagnostics'`;

  if (tables.length === 0) return null;

  const identity = yield* normalizeIdentity(attemptId);
  const rows = yield* session.sql<{ payload_json: string }>`SELECT payload_json FROM attempt_diagnostics WHERE attempt_id=${identity}`;

  if (!rows[0]) return null;

  return yield* Either.flatMap(parseStoredJson(rows[0].payload_json), (value) => decodeStored(StoredJsonObject, value));
}).pipe(Effect.mapError(sqlError));
