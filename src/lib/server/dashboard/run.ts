import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Option, Scope } from "effect";
import { join } from "node:path";
import { CheckoutRefresh } from "../../../cli/pulse-refresh.ts";
import { localRunLogLimit, type LocalRunLogEntry, type LocalRunStatus } from "../../contracts/local-run.ts";
import { stageNames, type PipelineProgress, type StageName } from "../../contracts/pipeline-progress.ts";
import type { ScheduledRefreshOutcome } from "../orchestration/run-scheduled.ts";
import { pipelineRecords } from "../orchestration/pipeline-records.ts";
import { macPiUnavailable, piNodeTooOld } from "../orchestration/pipeline-review.ts";
import { requiresRunReset, type RunRecord } from "../orchestration/pipeline-core.ts";
import { diagnoseWindowsFailure } from "../orchestration/windows-failure-report.ts";
import { withInstallationLock, WorkflowLockError } from "../orchestration/workflow-locks.ts";
import { ProfileFiles } from "../profile/files.ts";
import type { LocalSettingsTarget } from "../profile/local-settings.ts";
import { DashboardConfig } from "./config.ts";

type Admission = "started" | "busy" | "changed" | "unavailable" | "closing";

export class DashboardRun extends Context.Tag("pulse/DashboardRun")<DashboardRun, {
  readonly start: (resetRunId: string | null) => Effect.Effect<Admission>;
  readonly status: Effect.Effect<LocalRunStatus | null>;
  readonly setClosing: (sequence: number, closing: boolean) => Effect.Effect<boolean | null>;
} | null>() {}

const blank = (status: LocalRunStatus["status"], stageStatus: "pending" | "unknown"): LocalRunStatus => ({
  status, current_stage: null, stages: stageNames.map((stage) => ({ stage, status: stageStatus })),
  started_at: null, ended_at: null, retry_at: null, reset_run_id: null, error: null, log: [],
});

const updateStage = (state: LocalRunStatus, stage: StageName, status: LocalRunStatus["stages"][number]["status"]) =>
  state.stages.map((entry) => entry.stage === stage ? { ...entry, status } : entry);

type LogText = Pick<typeof LocalRunLogEntry.Type, "stage" | "level" | "message">;

const appendLog = (state: LocalRunStatus, time: string, line: LogText): LocalRunStatus => ({
  ...state, log: [...state.log.slice(1 - localRunLogLimit), { ...line, time, sequence: (state.log.at(-1)?.sequence ?? 0) + 1 }],
});

const stageMessages = {
  "sync-source": { start: "Reading NAV.", finish: "Finished reading NAV." },
  "resolve-locations": { start: "Resolving job locations.", finish: "Finished resolving job locations." },
  market: { start: "Recording market data.", finish: "Market data recorded." },
  review: { start: "Preparing to review jobs.", finish: "Finished reviewing jobs." },
  snapshot: { start: "Saving the dashboard snapshot.", finish: "Dashboard snapshot saved." },
} satisfies Record<StageName, { start: string; finish: string }>;

const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

// Render only fixed messages and validated counts. Do not forward raw stage results.
const logText = (event: PipelineProgress): LogText | undefined => {
  const info = (stage: LogText["stage"], message: string): LogText => ({ stage, message, level: "info" });

  switch (event.phase) {
    case "attempt": return info(null, "Checking refresh readiness.");
    case "started": return info(event.stage, stageMessages[event.stage].start);
    case "waiting": return { stage: event.stage, level: "warning", message: "Stage failed. Waiting to retry." };
    case "finished": {
      const { stage, status } = event;

      if (status === "failed") return { stage, level: stage === "market" ? "warning" : "error", message: "Stage failed." };

      return info(stage, status === "skipped" ? "Market recording is disabled." : stageMessages[stage].finish);
    }

    case "detail": {
      const { detail } = event;

      if (detail.kind === "rejudge-started") return info("review", "Starting re-judge.");

      if (!validCount(detail.count)) return undefined;

      switch (detail.kind) {
        case "nav-events": return info("sync-source", `NAV feed events read: ${detail.count}.`);
        case "eligible-jobs": return info("review", `Jobs eligible after area, occupation and exclusion filters: ${detail.count}.`);
        case "screened-out": return info("review", `Jobs screened out by title: ${detail.count}.`);
        case "review-batch": {
          if (!validCount(detail.batch) || detail.batch === 0) return undefined;
          const label = { screen: "Title screen", judge: "Judge", rejudge: "Re-judge" }[detail.step];

          return info("review", `${label} batch ${detail.batch} started (${detail.count} ${detail.count === 1 ? "job" : "jobs"}).`);
        }
      }
    }
  }
};

const progress = (state: LocalRunStatus, event: PipelineProgress): LocalRunStatus => {
  switch (event.phase) {
    case "detail": return state;
    case "attempt": return { ...state, current_stage: null, stages: blank("running", "pending").stages, retry_at: null };
    case "started": return { ...state, current_stage: event.stage, stages: updateStage(state, event.stage, "running") };
    case "finished": return {
      ...state, current_stage: null, stages: updateStage(state, event.stage, event.status),
      last_market_recording: event.marketRecording ?? state.last_market_recording,
    };
    case "waiting": return { ...state, current_stage: event.stage, stages: updateStage(state, event.stage, "waiting"), retry_at: event.retryAt };
  }
};

// Saved diagnostic tails can contain private text. Only display fixed messages.
const failureMessages = new Map([
  ["Review preflight failed (pi_unavailable).", "Pulse could not find Pi."],
  [piNodeTooOld, piNodeTooOld],
  [macPiUnavailable, "Select Claude Code for all active review steps on macOS. Pulse does not support Pi review on macOS."],
  ["Review preflight failed (claude_unavailable).", "Pulse could not find Claude Code."],
  ["Review outcome is unknown and was not retried.", "Pulse could not confirm the review result and did not retry it."],
  ["Review was blocked.", "Pulse could not start the review."],
  ["Cannot capture dashboard snapshot.", "Pulse could not save the dashboard snapshot."],
]);

const savedError = (record: RunRecord): string | null => {
  if (record.status === "completed") return null;

  if (record.status === "running" || record.status === "waiting") {
    return "The saved run has no final result. It may have stopped or be running outside this dashboard.";
  }

  const detail = record.failure_detail === null ? undefined : failureMessages.get(record.failure_detail);
  const preflight = record.last_outcome.startsWith("refused before stages: ");

  if (preflight || record.stage === null) {
    return `Refresh stopped during its readiness check.${detail === undefined ? "" : ` ${detail}`}`;
  }

  return detail ?? (record.status === "exhausted" ? "Refresh stopped after all retry attempts failed." : "A refresh stage failed.");
};

const restored = (record: RunRecord | null): LocalRunStatus => {
  if (record === null) return blank("idle", "pending");
  const state = blank(record.status === "completed" ? "succeeded" : "failed", "unknown");

  const stages = state.stages.map(({ stage, status }) => ({
    stage, status: record.stage_results?.[stage] ?? (record.stage_results === undefined || stage === record.stage ? status : "pending" as const),
  }));

  return {
    ...state, stages, ended_at: record.ended_at ?? null, last_market_recording: record.last_market_recording,
    reset_run_id: requiresRunReset(record) ? record.run_id : null,
    error: savedError(record),
  };
};

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

// The server scope owns the run. A request can wait for admission but does
// not own the work or the lease. No HTTP payload can choose a profile.
const makeDashboardRun = (target: LocalSettingsTarget, refresh: CheckoutRefresh["Type"]["run"]) => Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const files = yield* ProfileFiles;
  const selectedRoot = files.root(target.root);

  const readRecord = Effect.gen(function* () {
    const root = yield* selectedRoot;
    const records = yield* pipelineRecords(root, join(root, "local_only", "profiles", target.profileId, "local-pipeline-run.json"), target.profileId);

    return yield* records.read;
  });

  const recordServices = yield* Effect.context<Effect.Effect.Context<typeof readRecord>>();

  const readSaved = readRecord.pipe(
    Effect.map((record) => ({ record, panel: restored(record) })),
    Effect.orElseSucceed(() => null), Effect.provide(recordServices),
  );

  let closeSequence = 0;
  let closing = false;
  let owned = false;
  let state: LocalRunStatus | null = null;
  let failureRecord: RunRecord | null | undefined;

  // Block starts and sample ownership in the same turn. Ownership begins
  // before admission awaits the lock and includes retry waits.
  const setClosing = (sequence: number, next: boolean) => Effect.sync(() => {
    if (sequence <= closeSequence) return null;
    closeSequence = sequence;
    closing = next;

    return owned;
  });

  const start = (resetRunId: string | null) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    if (closing) return "closing" as const;

    if (owned) return "busy" as const;

    owned = true;
    const admitted = yield* Deferred.make<Admission>();
    let completed: ScheduledRefreshOutcome | undefined;
    let final: Effect.Effect.Success<typeof readSaved> = null;
    let refused: Admission = "unavailable";

    const setResult = (exit: Exit.Exit<ScheduledRefreshOutcome, unknown>, saved?: LocalRunStatus) => Effect.gen(function* () {
      if (state?.status !== "running") return;
      const current = state;
      const succeeded = Exit.isSuccess(exit) && exit.value.exitCode === 0 && exit.value.completionIds.length === 1;
      const ended_at = yield* now;

      state = {
        ...current, status: succeeded ? "succeeded" : "failed", current_stage: null, retry_at: null, ended_at,
        stages: current.stages.map((entry) => entry.status === "running" || entry.status === "waiting"
          ? { ...entry, status: "failed" } : entry),
        reset_run_id: succeeded ? null : saved?.reset_run_id ?? null,
        error: succeeded ? null : Exit.isInterrupted(exit) ? "The dashboard stopped the run."
          : saved?.error ?? "Pulse did not save a reason. Try again. If it stops again, check your Pulse setup.",
      };
      state = appendLog(state, ended_at, {
        stage: null, level: succeeded ? "info" : "error",
        message: state.error ?? "Complete. The new data is in the dashboard.",
      });
    }).pipe(Effect.uninterruptible);

    const execute = Effect.gen(function* () {
      const root = yield* selectedRoot;

      return yield* withInstallationLock(root, (lease) => Effect.gen(function* () {
        const saved = yield* readSaved;

        if (saved === null || resetRunId !== saved.panel.reset_run_id) {
          refused = saved === null ? "unavailable" : "changed";

          return;
        }

        const started_at = yield* now;
        failureRecord = undefined;
        state = appendLog({ ...blank("running", "pending"), started_at, last_market_recording: saved.panel.last_market_recording }, started_at, {
          stage: null, level: "info", message: "Refresh started.",
        });
        yield* Deferred.succeed(admitted, "started");

        const outcome = yield* refresh({
          root, id: target.profileId, lease, noPublish: true, railway: () => null,
          reset: resetRunId !== null,
          reportCompleted: (outcome) => Effect.sync(() => { completed = outcome; }).pipe(
            Effect.zipRight(setResult(Exit.succeed(outcome))), Effect.uninterruptible,
          ),
          onProgress: (event) => now.pipe(Effect.map((time) => {
            if (state?.status !== "running") return;
            state = progress(state, event);
            const line = logText(event);

            if (line !== undefined) state = appendLog(state, time, line);
          })),
        });

        if (outcome.exitCode !== 0) final = yield* readSaved;

        return outcome;
      }));
    });

    const worker = Effect.interruptible(execute).pipe(diagnoseWindowsFailure<ScheduledRefreshOutcome | undefined>(
      "dashboard-run", "runner", (result) => result === undefined || (result.exitCode === 0 && result.completionIds.length === 1) ? null
        : { stage: result.failedStage ?? "pipeline", exitCode: result.exitCode },
      { committed: () => completed },
    ), Effect.onExit((exit) => Effect.gen(function* () {
      if (Exit.isFailure(exit)) yield* setResult(Exit.failCause(exit.cause));
      else if (exit.value !== undefined) {
        failureRecord = final?.record;
        yield* setResult(Exit.succeed(exit.value), final?.panel);
      }

      owned = false;

      const busy = Exit.isFailure(exit) && Option.exists(Cause.failureOption(exit.cause),
        (error) => error instanceof WorkflowLockError && error.code === "busy",
      );

      yield* Deferred.succeed(admitted, busy ? "busy" : refused);
    })));

    yield* Effect.forkIn(worker, scope);

    return yield* restore(Deferred.await(admitted));
  }));

  return {
    start,
    setClosing,
    status: Effect.suspend(() => owned && state?.status === "running" ? Effect.succeed(state) : readSaved.pipe(
      Effect.map((saved) => {
        if (saved === null) return null;

        if (state === null) return saved.panel;

        if (owned) return state;

        // An external refresh can replace the failure or update Market evidence.
        if (failureRecord !== undefined && (saved.record?.run_id !== failureRecord?.run_id
          || saved.record?.status !== failureRecord?.status)) return saved.panel;

        if (saved.panel.reset_run_id !== null && saved.panel.reset_run_id !== state.reset_run_id) return saved.panel;

        return { ...state, reset_run_id: saved.panel.reset_run_id, last_market_recording: saved.panel.last_market_recording };
      }),
    )),
  };
});

export const DashboardRunLive = Layer.scoped(DashboardRun, Effect.gen(function* () {
  const config = yield* DashboardConfig;

  if (config.mode !== "local" || config.localSettings === undefined) return null;
  const { run } = yield* CheckoutRefresh;

  return yield* makeDashboardRun(config.localSettings, run);
}));
