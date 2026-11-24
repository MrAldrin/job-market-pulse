import { Clock, Effect, Either, Match, Option, Schema } from "effect";
import { MarketRecording, type FinishedStageStatus, type PipelineProgress } from "../../contracts/pipeline-progress.ts";
import { completedRecord, enterStage, failedStage, passedStage, PipelineError, refusedRecord, resumeWait, sanitizedTail, stageNames, stageOutcome, startDisposition, startRecord, type RunRecord, type StageOutcome, type StageName, type StageResult } from "./pipeline-core.ts";

export interface PipelineStage<R = never> {
  readonly name: StageName;
  readonly timeoutMillis: number;
  readonly run: (reviewerId: string) => Effect.Effect<StageResult, unknown, R>;
  readonly validOutput?: (output: string) => boolean;
}

export interface LockedPipelineOptions<R = never, S = never> {
  readonly profileId: string;
  readonly reviewerId: string | null;
  readonly reset: boolean;
  readonly once: boolean;
  readonly newRunId: () => string;
  readonly records: { readonly read: Effect.Effect<RunRecord | null, PipelineError>; readonly write: (record: RunRecord) => Effect.Effect<void, PipelineError> };
  readonly preflight: (reviewerId: string) => Effect.Effect<StageResult, unknown, R>;
  readonly stages: readonly PipelineStage<S>[];
  readonly onProgress?: ((progress: PipelineProgress) => Effect.Effect<void>) | undefined;
}

export interface PipelineOutput {
  readonly status: string;
  readonly run_id: string | null;
  readonly stage: StageName | null;
  readonly next_attempt_at: string | null;
  readonly exitCode: number;
  readonly warnings: readonly string[];
}

// Effect's default clock treats delays above the native timer range as infinite.
// The retained review loop has a larger outer deadline, so sleep in bounded pieces.
const maxTimerMillis = 2 ** 31 - 1;

const withStageDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>, millis: number) => {
  if (millis <= maxTimerMillis) return effect.pipe(Effect.timeoutOption(millis));

  const expires = Effect.gen(function* () {
    let remaining = millis;

    while (remaining > 0) {
      const delay = Math.min(remaining, maxTimerMillis);
      yield* Effect.sleep(delay);
      remaining -= delay;
    }

    return Option.none<A>();
  });

  return Effect.raceFirst(effect.pipe(Effect.map(Option.some)), expires);
};

type ExecutionOutcome = StageOutcome & { readonly market?: StageResult["market"] };

const isStageResult = Schema.is(Schema.Struct({
  returncode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  market: Schema.optional(Schema.Union(
    Schema.Struct({ status: Schema.Literal("disabled") }),
    Schema.Struct({ status: Schema.Literal("recorded"), captured_at: MarketRecording.fields.captured_at }),
  )),
  warnings: Schema.optional(Schema.Array(Schema.String.pipe(Schema.maxLength(400))).pipe(Schema.maxItems(4))),
}));

// This function does not acquire locks. The caller must hold the installation,
// weekly and profile locks throughout the run, including retry waits.
export const runLockedPipeline = <R, S>(options: LockedPipelineOptions<R, S>) => Effect.gen(function* () {
  if (options.stages.length !== stageNames.length || options.stages.some((stage, index) => stage.name !== stageNames[index] || !Number.isFinite(stage.timeoutMillis) || stage.timeoutMillis <= 0)) {
    return yield* new PipelineError({ code: "stages_invalid" });
  }

  const previous = yield* options.records.read;
  const disposition = startDisposition(previous, options.reviewerId, options.reset);
  const warnings: string[] = [];
  const report = options.onProgress ?? (() => Effect.void);

  if (disposition.status !== "ready") return {
    status: disposition.status, run_id: previous?.run_id ?? null, stage: previous?.stage ?? null,
    next_attempt_at: previous?.next_attempt_at ?? null, exitCode: disposition.exitCode, warnings,
  } satisfies PipelineOutput;

  const now = () => Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());
  let record = startRecord(previous, { profileId: options.profileId, reviewerId: disposition.reviewerId, runId: options.newRunId(), reset: options.reset, now: yield* now() });

  const output = (exitCode: number): PipelineOutput => ({
    status: record.status, run_id: record.run_id, stage: record.stage, next_attempt_at: record.next_attempt_at, exitCode, warnings,
  });

  const admit = () => Effect.gen(function* () {
    yield* report({ phase: "attempt" });

    const result = yield* options.preflight(record.reviewer_id).pipe(Effect.either, Effect.timeoutOption(120_000));

    if (Option.isNone(result) || Either.isLeft(result.value) || !isStageResult(result.value.right)) {
      return { reason: "review preflight could not run", detail: null };
    }

    const check = result.value.right;

    return check.returncode === 0 ? null : {
      reason: `review preflight refused (exit ${check.returncode})`,
      detail: sanitizedTail(check.stderr) || sanitizedTail(check.stdout) || null,
    };
  });

  const saveStage = (stage: StageName, status: typeof FinishedStageStatus.Type) => {
    record = { ...record, stage_results: { ...record.stage_results, [stage]: status } };

    return options.records.write(record);
  };

  const refuse = (refusal: { readonly reason: string; readonly detail: string | null }) => Effect.gen(function* () {
    record = { ...refusedRecord({ ...record, stage_results: {} }, refusal.reason, refusal.detail), ended_at: yield* now() };
    yield* options.records.write(record);

    return output(2);
  });

  const initialRefusal = yield* admit();

  if (initialRefusal !== null) return yield* refuse(initialRefusal);

  if (previous?.status === "waiting") {
    const wait = resumeWait(previous, yield* now());

    if (Either.isLeft(wait)) {
      if (wait.left.code !== "retry_time_invalid") return yield* wait.left;

      return yield* refuse({ reason: "next_attempt_at is more than 5 hours away; record is invalid", detail: null });
    }

    const remaining = wait.right;

    if (remaining > 0) {
      if (options.once) return { ...output(75), status: "waiting" };

      if (previous.stage !== null && previous.next_attempt_at !== null) {
        yield* report({ phase: "waiting", stage: previous.stage, retryAt: previous.next_attempt_at });
      }

      yield* Effect.sleep(remaining);
      const refusal = yield* admit();

      if (refusal !== null) return yield* refuse(refusal);
    }
  }

  while (true) {
    let retry = false;
    record = { ...record, stage_results: {} };

    for (const stage of options.stages) {
      record = enterStage(record, stage.name);
      yield* options.records.write(record);

      yield* report({ phase: "started", stage: stage.name });

      const result = yield* withStageDeadline(stage.run(record.reviewer_id).pipe(
        Effect.either,
        Effect.map((execution): ExecutionOutcome => {
          if (Either.isLeft(execution)) return { kind: "permanent" as const, detail: "executor error", tail: null };
          const result = execution.right;

          if (!isStageResult(result)) return { kind: "permanent" as const, detail: "invalid executor result", tail: null };
          const outcome = stageOutcome(result, stage.validOutput);

          if (outcome.kind !== "passed") return { ...outcome, tail: sanitizedTail(result.stderr) || null };

          for (const warning of result.warnings ?? []) {
            const safe = sanitizedTail(warning);

            if (safe) warnings.push(safe);
          }

          return { ...outcome, market: result.market };
        }),
      ), stage.timeoutMillis);

      const outcome: ExecutionOutcome = Option.isNone(result) ? { kind: "temporary", detail: "timeout", tail: null } : result.value;

      if (stage.name === "market") {
        const market = outcome.kind === "passed" ? outcome.market : undefined;

        const status = Match.value(market?.status).pipe(
          Match.when("recorded", () => "recorded" as const),
          Match.when("disabled", () => "skipped" as const),
          Match.orElse(() => "failed" as const),
        );

        const marketRecording = market?.status === "recorded" ? { captured_at: market.captured_at, run_id: record.run_id } : undefined;

        if (status === "failed") warnings.push("market stage failed");

        if (marketRecording !== undefined) record = { ...record, last_market_recording: marketRecording };
        yield* saveStage(stage.name, status);
        yield* report({ phase: "finished", stage: stage.name, status, marketRecording });
        continue;
      }

      if (outcome.kind === "passed") {
        record = passedStage(record);
        yield* saveStage(stage.name, "succeeded");
        yield* report({ phase: "finished", stage: stage.name, status: "succeeded" });
        continue;
      }

      const failedAt = yield* now();
      record = yield* failedStage(record, outcome, failedAt);

      if (record.status !== "waiting") record = { ...record, ended_at: failedAt };
      yield* saveStage(stage.name, "failed");

      if (record.status !== "waiting" || options.once || record.next_attempt_at === null) {
        yield* report({ phase: "finished", stage: stage.name, status: "failed" });

        if (record.status === "failed") return output(2);

        return output(record.status === "exhausted" ? 1 : 75);
      }

      yield* report({ phase: "waiting", stage: stage.name, retryAt: record.next_attempt_at });
      const delay = yield* resumeWait(record, yield* now());
      yield* Effect.sleep(delay);
      const refusal = yield* admit();

      if (refusal !== null) return yield* refuse(refusal);
      retry = true;
      break;
    }

    if (!retry) {
      record = { ...completedRecord(record), ended_at: yield* now() };
      yield* options.records.write(record);

      return output(0);
    }
  }
});
