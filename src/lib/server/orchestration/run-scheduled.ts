import { Clock, Effect, Either, Exit } from "effect";
import { join } from "node:path";
import { ProfileFiles } from "../profile/files.ts";
import { isDue } from "../profile/schedule-period.ts";
import { pipelineRecords } from "./pipeline-records.ts";
import { osloDate, profilePeriod } from "./schedule-profile.ts";
import { finishScheduledRun, startScheduledRun } from "./scheduled-runs.ts";
import { withInstallationLock, WorkflowLockError, type InstallationLease } from "./workflow-locks.ts";

export interface ScheduledRefreshOutcome {
  readonly exitCode: number;
  readonly completionIds: readonly string[];
  readonly requiresReset?: true;
  readonly failedStage?: "preflight" | "review-preflight" | "pipeline" | "sync-source" | "resolve-locations" | "review" | "snapshot" | "snapshot-export" | "upload" | "runner";
}

type ScheduledFailureStage = NonNullable<ScheduledRefreshOutcome["failedStage"]> | "schedule" | "lock" | "interrupted";

export interface ScheduledOptions<R> {
  readonly root: string;
  readonly profileId: string;
  readonly onlyIfDue: boolean;
  readonly period?: string;
  readonly anchor?: string;
  readonly prepareAlert?: (root: string) => Effect.Effect<Effect.Effect<void>, never, R>;
  readonly reportResult?: (code: number, historyUnavailable?: true) => Effect.Effect<void>;
  readonly alertFailure?: (root: string) => Effect.Effect<void, never, R>;
  readonly onFailure?: (stage: ScheduledFailureStage, code: number) => Effect.Effect<void>;
  readonly refresh: (root: string, lease: InstallationLease) => Effect.Effect<ScheduledRefreshOutcome, unknown, R>;
}

// The injected refresh owns all work, including any export and upload. Its
// completion claim is checked against the profile's persisted pipeline record.
export const runScheduled = <R>(options: ScheduledOptions<R>) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const root = yield* files.root(options.root);
  const now = () => Effect.map(Clock.currentTimeMillis, (value) => new Date(value).toISOString());
  const started = yield* now();

  const schedule = yield* Effect.either(Effect.gen(function* () {
    const periodOptions = { now: started, requireAnchor: options.onlyIfDue };

    if (options.period !== undefined) Object.assign(periodOptions, { text: options.period });

    if (options.anchor !== undefined) Object.assign(periodOptions, { anchor: options.anchor });

    const period = yield* profilePeriod(root, options.profileId, periodOptions);

    return options.onlyIfDue ? yield* isDue(period, yield* osloDate(started)) : true;
  }));

  if (Either.isRight(schedule) && !schedule.right) return 0;

  const report = (code: number, historyUnavailable?: true) => options.reportResult?.(code, historyUnavailable) ?? Effect.void;

  const run = Effect.gen(function* () {
    const id = yield* startScheduledRun(root, options.profileId, started);

    if (id === null) return yield* report(2).pipe(Effect.as(2));

    // Defer cancellation until the history, stage and CLI result agree.
    const finish = (stage: ScheduledFailureStage | null, code: number) => Effect.gen(function* () {
      yield* finishScheduledRun(root, options.profileId, id, yield* now(), stage);

      if (stage !== null) yield* options.onFailure?.(stage, code) ?? Effect.void;

      if (stage !== "interrupted") yield* report(code);
    }).pipe(Effect.uninterruptible);

    if (Either.isLeft(schedule)) {
      yield* finish("schedule", 2);

      return 2;
    }

    return yield* withInstallationLock(root, (lease) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const attempt = yield* Effect.exit(restore(Effect.gen(function* () {
        const records = yield* pipelineRecords(root, join(root, "local_only", "profiles", options.profileId, "local-pipeline-run.json"), options.profileId);
        const before = yield* records.read;
        const notify = yield* (options.prepareAlert?.(root) ?? Effect.succeed(Effect.void));
        const outcome = yield* options.refresh(root, lease);

        if (outcome.exitCode !== 0) return { code: outcome.exitCode, stage: outcome.failedStage ?? "runner", notify: Effect.void };

        if (outcome.failedStage !== undefined || outcome.completionIds.length !== 1 || !outcome.completionIds[0]) return { code: 1, stage: "runner", notify: Effect.void } as const;
        const record = yield* records.read;
        const priorCompletion = before?.status === "completed" ? before.run_id : null;

        return record?.status === "completed" && record.run_id === outcome.completionIds[0] && record.run_id !== priorCompletion
          ? { code: 0, stage: null, notify } : { code: 1, stage: "pipeline", notify: Effect.void } as const;
      })));

      if (Exit.isFailure(attempt)) {
        if (Exit.isInterrupted(attempt)) {
          yield* finish("interrupted", 130);

          return yield* Effect.failCause(attempt.cause);
        }

        yield* finish("runner", 1);

        return 1;
      }

      yield* finish(attempt.value.stage, attempt.value.code);

      if (attempt.value.code === 0) yield* restore(attempt.value.notify);

      return attempt.value.code;
    }))).pipe(Effect.catchAll((error) => {
      if (error instanceof WorkflowLockError) {
        const code = error.code === "busy" ? 75 : 1;

        return finish(error.code === "busy" ? "lock" : "runner", code).pipe(Effect.as(code));
      }

      return Effect.fail(error);
    }));
  });

  const alertFailure = Effect.suspend(() => options.alertFailure?.(root) ?? Effect.void);

  return yield* run.pipe(
    Effect.tap((code) => code === 0 ? Effect.void : alertFailure),
    Effect.tapError(() => report(1, true).pipe(Effect.zipRight(alertFailure))),
  );
});
