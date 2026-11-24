import { Either, Option, Predicate, Schema } from "effect";
import { Identity, type AttemptStatus, type RunStatus, type StageInput, type ReviewStage } from "../../contracts/judge-state.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { pythonJson, sha256, type PythonJson } from "../shared/python-json.ts";
import { JudgeStateError } from "./errors.ts";

export const REJUDGE_STAGE_VERSION = "personal-rejudge-stage-v1";
export const REJUDGE_SCOPE = "rejudge";

export const REREVIEW_STAGE_VERSION = "personal-review-stage-v1-rereview";
export const MAX_RUN_CANDIDATES = 10_000;
export const MAX_MODEL_CALLS_PER_RUN = 32;
export const MAX_AUTO_RETRIES = 10;
export const PERMANENT_MODEL_UNKNOWN = "review_outcome_unknown";
export const PROFILE_CALL_WINDOW_MICROS = 86_400_000_000n;

export const AUTO_RETRY_ERROR_CODES = new Set([
  "invalid_model_json", "invalid_model_response", "model_response_too_large",
  "model_token_budget_exceeded", "unexpected_tool_call",
]);

// CPython UUID accepts braces, arbitrary hyphen placement and urn:uuid prefixes.
// The normalized value is used before any identity is persisted or compared.
export const normalizeIdentity = (value: string): Either.Either<string, JudgeStateError> => {
  const hex = value.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^\{+|\}+$/g, "").replaceAll("-", "");

  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    return Either.left(new JudgeStateError({ message: "Identity must be a UUID" }));
  }

  const text = hex.toLowerCase();
  const normalized = `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;

  return Either.mapLeft(Schema.decodeUnknownEither(Identity)(normalized), (cause) =>
    new JudgeStateError({ message: "Identity must be a UUID", cause }),
  );
};

export const fingerprint = (value: PythonJson): string => sha256(pythonJson(value));

export const instant = (text: string): Either.Either<bigint, JudgeStateError> => {
  const parsed = parseIsoTime(text);

  return Option.isSome(parsed) && parsed.value.aware
    ? Either.right(parsed.value.epochMicros)
    : Either.left(new JudgeStateError({ message: "Timestamp must be timezone-aware" }));
};

export const isoInstant = (textOrMicros: string | bigint) => Either.flatMap(Predicate.isBigInt(textOrMicros) ? Either.right(textOrMicros) : instant(textOrMicros), (micros) =>
  Either.map(utcText(micros), (value) => value.replace(".000000+", "+")),
);

// Store timestamps use UTC and always six fractional digits. Source-version text
// is separate and is never rewritten by this helper.
export const utcText = (epochMicros: bigint): Either.Either<string, JudgeStateError> => {
  if (epochMicros < -62_135_596_800_000_000n || epochMicros >= 253_402_300_800_000_000n) {
    return Either.left(new JudgeStateError({ message: "Timestamp is outside the supported calendar" }));
  }

  const seconds = epochMicros >= 0n ? epochMicros / 1_000_000n : (epochMicros - 999_999n) / 1_000_000n;
  const fraction = epochMicros - seconds * 1_000_000n;
  const date = new Date(Number(seconds * 1000n));

  return Either.right(`${date.toISOString().slice(0, 19)}.${fraction.toString().padStart(6, "0")}+00:00`);
};

export const batchFingerprint = (stage: ReviewStage, stageVersion: string, promptVersion: string, inputs: readonly StageInput[]): string => fingerprint({
  stage,
  stage_version: stageVersion,
  prompt_version: promptVersion,
  inputs: [...inputs].sort((left, right) => left.listing_id < right.listing_id ? -1 : left.listing_id > right.listing_id ? 1 : 0).map((item) => ({
    listing_id: item.listing_id,
    source_version: item.source_version,
    input_fingerprint: item.input_fingerprint,
    source_text_fingerprint: item.source_text_fingerprint,
    upstream_result_id: item.upstream_result_id,
  })),
});

export const isOpenRun = (status: RunStatus): boolean => status === "pending" || status === "running" || status === "partial";
export const isTerminalAttempt = (status: AttemptStatus): boolean => status !== "pending" && status !== "running";

export const finishedRunStatus = (candidateCount: number, completed: number, screenedOut: number, attempts: readonly AttemptStatus[]): RunStatus => {
  const done = completed + screenedOut;

  if (done === candidateCount) return "completed";

  if (done === 0 && attempts.length > 0) {
    if (attempts.every((status) => status === "blocked")) return "blocked";

    if (attempts.every((status) => status === "failed")) return "failed";
  }

  return "partial";
};
