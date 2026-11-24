import { Data, Either, Match, Option, Schema } from "effect";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { boundedInteger } from "../../contracts/support.ts";
import type { JsonInput } from "../shared/json-input.ts";
import { utcText } from "../source/core.ts";

import { FinishedStageStatus, MarketRecording, PipelineStageName, type StageName } from "../../contracts/pipeline-progress.ts";

export { stageNames, type StageName } from "../../contracts/pipeline-progress.ts";

export const retryWaitMillis = [300_000, 3_600_000, 18_000_000] as const;

export const maximumFailures = retryWaitMillis.length + 1;

export class PipelineError extends Data.TaggedError("PipelineError")<{
  readonly code: string;
}> {}

const identifier = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/));

const reviewer = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/));

const instant = Schema.String.pipe(Schema.filter((value) => {
  const parsed = parseIsoTime(value);

  return Option.isSome(parsed) && parsed.value.aware;
}));

const text = (maximum: number) => Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximum));

// New evidence is optional so older private run records still decode.
export const RunRecordSchema = Schema.Struct({
  run_id: identifier,
  profile_id: Schema.String,
  reviewer_id: reviewer,
  status: Schema.Literal("running", "waiting", "completed", "failed", "exhausted"),
  stage: Schema.NullOr(PipelineStageName),
  failed_attempts: boundedInteger(0, maximumFailures),
  last_outcome: text(300),
  next_attempt_at: Schema.NullOr(instant),
  previous_run_id: Schema.NullOr(identifier),
  reset_at: Schema.NullOr(instant),
  failure_detail: Schema.NullOr(Schema.String.pipe(Schema.maxLength(500))),
  ended_at: Schema.optionalWith(instant, { exact: true }),
  stage_results: Schema.optionalWith(Schema.partialWith(Schema.Record({ key: PipelineStageName, value: FinishedStageStatus }), { exact: true }), { exact: true }),
  last_market_recording: Schema.optionalWith(MarketRecording, { exact: true }),
});

export type RunRecord = typeof RunRecordSchema.Type;

const fail = (code: string) => Either.left(new PipelineError({ code }));

export const decodeRunRecord = (value: JsonInput, profileId: string): Either.Either<RunRecord, PipelineError> => {
  const decoded = Schema.decodeUnknownEither(RunRecordSchema, { onExcessProperty: "error" })(value);

  if (Either.isLeft(decoded)) return fail("record_invalid");
  const record = decoded.right;

  if (record.profile_id !== profileId) return fail("record_profile_mismatch");

  if (record.reset_at !== null && record.previous_run_id === null) return fail("record_reset_invalid");
  const failed = record.failed_attempts;

  const valid = Match.value(record.status).pipe(
    Match.when("waiting", () => record.next_attempt_at !== null && record.stage !== null && failed >= 1 && failed < maximumFailures),
    Match.when("exhausted", () => record.next_attempt_at === null && record.stage !== null && failed === maximumFailures),
    Match.when("completed", () => record.next_attempt_at === null && record.stage === "snapshot" && failed < maximumFailures),
    Match.orElse(() => record.next_attempt_at === null && failed < maximumFailures),
  );

  return valid ? Either.right(record) : fail("record_inconsistent");
};

export type StartDisposition = { readonly status: "ready"; readonly reviewerId: string } | {
  readonly status: "resume_required" | "previous_stopped";
  readonly exitCode: 1 | 2;
};

export const requiresRunReset = (record: RunRecord | null): boolean =>
  record?.status === "exhausted" || (record?.status === "failed" && record.stage !== null);

export const startDisposition = (previous: RunRecord | null, requested: string | null, reset: boolean): StartDisposition => {
  const unfinished = previous !== null && (previous.status === "running" || previous.status === "waiting");

  if (unfinished && (reset || (requested !== null && requested !== previous.reviewer_id))) {
    return { status: "resume_required", exitCode: 2 };
  }

  if (previous !== null && requiresRunReset(previous) && !reset) {
    return { status: "previous_stopped", exitCode: previous.status === "exhausted" ? 1 : 2 };
  }

  return { status: "ready", reviewerId: unfinished ? previous.reviewer_id : requested ?? "judge" };
};

export const startRecord = (previous: RunRecord | null, options: {
  readonly profileId: string;
  readonly reviewerId: string;
  readonly runId: string;
  readonly reset: boolean;
  readonly now: string;
}): RunRecord => {
  if (previous?.status === "running" || previous?.status === "waiting") return { ...previous, status: "running" };

  const record: RunRecord = {
    run_id: options.runId, profile_id: options.profileId, reviewer_id: options.reviewerId,
    status: "running", stage: null, failed_attempts: 0, last_outcome: "started", next_attempt_at: null,
    previous_run_id: previous?.run_id ?? null, reset_at: previous !== null && options.reset ? options.now : null,
    failure_detail: null,
  };

  return previous?.last_market_recording === undefined ? record : { ...record, last_market_recording: previous.last_market_recording };
};

const micros = (value: string): Either.Either<bigint, PipelineError> => {
  const parsed = parseIsoTime(value);

  return Option.isSome(parsed) && parsed.value.aware ? Either.right(parsed.value.epochMicros) : fail("clock_invalid");
};

export const resumeWait = (previous: RunRecord, now: string): Either.Either<number, PipelineError> => {
  if (previous.status !== "waiting" || previous.next_attempt_at === null) return Either.right(0);
  const current = micros(now), until = micros(previous.next_attempt_at);

  if (Either.isLeft(current)) return Either.left(current.left);

  if (Either.isLeft(until)) return Either.left(until.left);
  const remaining = until.right - current.right;

  if (remaining > 18_000_000_000n) return fail("retry_time_invalid");
  const scheduled = retryWaitMillis[previous.failed_attempts - 1];

  if (scheduled === undefined) return fail("record_inconsistent");

  return Either.right(Math.max(0, Math.min(Number(remaining) / 1000, scheduled)));
};

const secretPatterns = [
  /bearer\s+\S+/gi,
  /(token|secret|password|api[_-]?key|authorization)\S*\s*[:=]\s*\S+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9+/_-]{32,}={0,2}/g,
  /\/(?:home|root|Users)\/\S+/g,
];

export const sanitizedOutput = (value: string): string => {
  let output = Array.from(value, (character) => /[\p{C}\p{Zl}\p{Zp}]/u.test(character) && character !== "\n" ? " " : character).join("");

  for (const pattern of secretPatterns) output = output.replace(pattern, "[redacted]");

  return output;
};

export const sanitizedTail = (value: string): string => sanitizedOutput(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5).join("\n")).slice(-400);
const bounded = (value: string): string => value.length <= 300 ? value : value.slice(0, 297) + "...";

export const enterStage = (record: RunRecord, stage: StageName): RunRecord => ({ ...record, status: "running", stage, next_attempt_at: null });

export const passedStage = (record: RunRecord): RunRecord => ({ ...record, last_outcome: `passed ${record.stage}`, failure_detail: null });

export const completedRecord = (record: RunRecord): RunRecord => ({ ...record, status: "completed", next_attempt_at: null, failure_detail: null });

export const refusedRecord = (record: RunRecord, reason: string, detail: string | null = null): RunRecord => ({
  ...record, status: "failed", last_outcome: bounded(`refused before stages: ${reason}`), next_attempt_at: null,
  failure_detail: detail === null ? null : sanitizedTail(detail),
});

export interface StageResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly warnings?: readonly string[];
  readonly market?: { readonly status: "disabled" } | { readonly status: "recorded"; readonly captured_at: string };
}

export type StageOutcome = { readonly kind: "passed" | "temporary" | "permanent"; readonly detail: string; readonly tail: string | null };

export const stageOutcome = (result: StageResult, validOutput?: (output: string) => boolean): StageOutcome => {
  if (result.returncode === 0) return validOutput && !validOutput(result.stdout)
    ? { kind: "permanent", detail: "invalid output", tail: null }
    : { kind: "passed", detail: "exit 0", tail: null };

  return {
    kind: result.returncode === 75 ? "temporary" : "permanent", detail: `exit ${result.returncode}`,
    tail: sanitizedTail(result.stderr) || null,
  };
};

export const failedStage = (record: RunRecord, outcome: StageOutcome, now: string): Either.Either<RunRecord, PipelineError> => {
  if (outcome.kind === "passed") return Either.right(passedStage(record));

  if (outcome.kind === "permanent") return Either.right({
    ...record, status: "failed", last_outcome: bounded(`permanent ${record.stage}: ${outcome.detail}`),
    next_attempt_at: null, failure_detail: outcome.tail,
  });
  const failed = record.failed_attempts + 1;
  const common = { ...record, failed_attempts: failed, last_outcome: `temporary ${record.stage}: ${outcome.detail}`, failure_detail: outcome.tail };

  if (failed >= maximumFailures) return Either.right({ ...common, status: "exhausted", next_attempt_at: null });
  const current = micros(now);

  if (Either.isLeft(current)) return Either.left(current.left);

  const delay = retryWaitMillis[failed - 1];

  if (delay === undefined) return fail("record_inconsistent");

  return Either.right({ ...common, status: "waiting", next_attempt_at: utcText(current.right + BigInt(delay) * 1000n) });
};
