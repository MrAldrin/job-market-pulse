import { Console, Context, Effect, Either, Layer } from "effect";
import { join } from "node:path";
import type { PipelineProgress } from "../lib/contracts/pipeline-progress.ts";
import { rerunOlderReviews, runLocalPipeline } from "../lib/server/orchestration/local-pipeline.ts";
import { prepareTopJobsAlert } from "../lib/server/orchestration/ntfy-notifications.ts";
import { pipelineRecords } from "../lib/server/orchestration/pipeline-records.ts";
import type { ScheduledRefreshOutcome } from "../lib/server/orchestration/run-scheduled.ts";
import { requireInstallationLease, withInstallationLock, type InstallationLease } from "../lib/server/orchestration/workflow-locks.ts";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { prepareUpload, refreshPublishSettings, selectedSnapshot, sendUpload } from "./pulse-publish.ts";

export interface RefreshOptions {
  readonly root: string;
  readonly id: string;
  readonly noPublish?: boolean;
  readonly noNotify?: boolean;
  readonly scheduled?: boolean;
  readonly once?: boolean;
  readonly reset?: boolean;
  readonly lease?: InstallationLease;
  readonly onProgress?: ((progress: PipelineProgress) => Effect.Effect<void>) | undefined;
  readonly reportCompleted?: (outcome: ScheduledRefreshOutcome) => Effect.Effect<void>;
  readonly volume?: string | undefined;
  readonly railway: () => string | null;
}

export const refresh = (options: RefreshOptions, pipeline = runLocalPipeline) => Effect.gen(function* () {
  const stop = (failedStage: NonNullable<ScheduledRefreshOutcome["failedStage"]>, message: string, exitCode = 1) =>
    Console.error(message).pipe(Effect.as({ exitCode, completionIds: [], failedStage } satisfies ScheduledRefreshOutcome));

  if (options.noNotify && (!options.noPublish || options.scheduled || options.reset)) {
    return yield* stop("preflight", "--no-notify requires --no-publish and cannot be used with a scheduled run or reset.", 2);
  }

  const root = yield* (yield* ProfileFiles).root(options.root);
  const id = yield* decodeProfileId(options.id);

  const settings = yield* Effect.either(options.noPublish ? Effect.succeed(null)
    : refreshPublishSettings(root, id, options.scheduled ?? false, { volume: options.volume }));

  if (Either.isLeft(settings)) return yield* stop("preflight", `Refresh not started: ${settings.left.message}`, 2);

  const target = settings.right;
  const railway = target === null ? null : options.railway();

  if (target !== null && railway === null) return yield* stop("preflight", `Refresh not started: upload is configured but the Railway CLI is not available. ${
    options.scheduled ? "Add Railway to the timer's PATH or remove the upload configuration." : "Use --no-publish to run locally."
  }`, 2);

  const execute = (lease: InstallationLease) => Effect.scoped(Effect.gen(function* () {
    yield* Console.error(`Refresh: running the pipeline for '${id}'.`);

    const notify = options.scheduled || options.noNotify ? Effect.void : yield* prepareTopJobsAlert(root, id);

    const result = yield* pipeline({
      root, profileId: id, once: options.once ?? false, reset: options.reset ?? false, installationLease: lease,
      onProgress: options.onProgress,
    });

    for (const warning of result.warnings) yield* Console.error(warning);

    if (result.status !== "completed" || result.exitCode !== 0 || result.run_id === null) {
      const stage = process.platform !== "win32" ? "pipeline"
        : result.stage !== null && result.stage !== "market" ? result.stage
        : result.status === "failed" ? "review-preflight" : "preflight";

      const stopped = yield* stop(stage, `Refresh stopped: ${result.status}. No snapshot uploaded.`, result.exitCode || 1);

      return result.status === "previous_stopped" ? { ...stopped, requiresReset: true as const } : stopped;
    }

    const directory = join(root, "local_only", "profiles", id);
    const records = yield* pipelineRecords(root, join(directory, "local-pipeline-run.json"), id);
    const record = yield* records.read;

    if (record?.status !== "completed" || record.run_id !== result.run_id) return yield* stop("pipeline", "Run record did not confirm completion. No snapshot uploaded.");

    const upload = target === null ? null
      : yield* selectedSnapshot(root, id).pipe(Effect.flatMap((path) => prepareUpload(path, id, target)), Effect.either);

    if (upload !== null && Either.isLeft(upload)) return yield* stop("snapshot-export", upload.left.message);

    if (upload !== null) {
      const sent = yield* Effect.either(sendUpload(upload.right, railway, root));

      if (Either.isLeft(sent)) return yield* stop("upload", sent.left.message);
    }

    yield* Console.error(upload === null ? "Refresh completed. Dashboard kept local." : "Refresh completed. Dashboard snapshot uploaded.");

    const completed = { exitCode: 0, completionIds: [result.run_id] } satisfies ScheduledRefreshOutcome;
    // Establish the result before the cancellable, best-effort send.
    yield* (options.reportCompleted?.(completed) ?? Effect.void);
    yield* notify;

    return completed;
  }));

  return yield* (options.lease === undefined ? withInstallationLock(root, execute)
    : requireInstallationLease(root, options.lease).pipe(Effect.zipRight(execute(options.lease))));
}).pipe(Effect.catchTags({
  ProfileError: () => Console.error("Refresh not started: invalid root or profile.").pipe(Effect.as({ exitCode: 2, completionIds: [], failedStage: "preflight" } as const)),
  PipelineError: () => Console.error("Cannot read the completed run record. No snapshot uploaded.").pipe(Effect.as({ exitCode: 1, completionIds: [], failedStage: "pipeline" } as const)),
  WorkflowLockError: (error) => Console.error(error.code === "busy" ? "Another run holds the installation lock." : "Cannot use the installation lock.").pipe(
    Effect.as({ exitCode: error.code === "busy" ? 75 : 2, completionIds: [], failedStage: "preflight" } as const),
  ),
}));

export class CheckoutRefresh extends Context.Tag("pulse/CheckoutRefresh")<CheckoutRefresh, {
  readonly run: (options: RefreshOptions) => Effect.Effect<ScheduledRefreshOutcome>;
  readonly rereview?: (root: string, id: string, selection: true | readonly string[]) => Effect.Effect<number>;
}>() {}

export const CheckoutRefreshLive = Layer.effect(CheckoutRefresh, Effect.context<Effect.Effect.Context<ReturnType<typeof refresh>>>().pipe(
  Effect.map((context) => CheckoutRefresh.of({
    run: (options) => refresh(options).pipe(Effect.provide(context)),
    rereview: (root, id, selection) => rerunOlderReviews(root, id, selection).pipe(
      Effect.provide(context),
      Effect.flatMap((result) => result.returncode === 0 ? Console.log("Re-review finished. Snapshot kept local.").pipe(Effect.as(0))
        : Console.error(result.stderr).pipe(Effect.as(result.returncode))),
      Effect.catchAll(() => Console.error("Cannot start re-review. Check the profile and installation lock.").pipe(Effect.as(2))),
    ),
  })),
));
