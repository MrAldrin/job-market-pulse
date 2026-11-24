import { Effect } from "effect";
import { join } from "node:path";
import type { PipelineProgress } from "../../contracts/pipeline-progress.ts";
import { verifyWindowsPrivateSqlite } from "../shared/windows-private-files.ts";
import { decodeProfileId } from "../profile/core.ts";
import { ProfileFiles } from "../profile/files.ts";
import { ntfyEnabled } from "../profile/ntfy-settings.ts";
import { Profile } from "../profile/service.ts";
import { pipelineRecords } from "./pipeline-records.ts";
import { pipelineReview } from "./pipeline-review.ts";
import { runLockedPipeline, type PipelineOutput } from "./pipeline-runner.ts";
import { snapshotStage } from "./pipeline-snapshot.ts";
import { collectionStages } from "./pipeline-stages.ts";
import { acquirePipelineLocks, type InstallationLease } from "./workflow-locks.ts";

export const rerunOlderReviews = (rawRoot: string, profileId: string, selection: true | readonly string[]) => Effect.scoped(Effect.gen(function* () {
  const root = yield* (yield* ProfileFiles).root(rawRoot);
  const id = yield* decodeProfileId(profileId);
  yield* acquirePipelineLocks(root, id);
  const selected = yield* (yield* Profile).load(root, id);
  const review = pipelineReview(root, selected, selection);
  const admitted = yield* review.preflight("judge");

  if (admitted.returncode !== 0) return admitted;
  const result = yield* review.stage.run();

  if (result.returncode !== 0) return result;
  const snapshot = yield* snapshotStage(selected, review.admittedModels, yield* ntfyEnabled(root));

  return yield* snapshot.run();
}));

export interface LocalPipelineOptions {
  readonly root: string;
  readonly profileId: string;
  readonly once?: boolean;
  readonly reset?: boolean;
  readonly installationLease?: InstallationLease;
  readonly onProgress?: ((progress: PipelineProgress) => Effect.Effect<void>) | undefined;
}

const notStarted = (warning: string): PipelineOutput => ({
  status: "not_started", run_id: null, stage: null, next_attempt_at: null, exitCode: 2, warnings: [warning],
});

// The caller can supply its active installation lease, but cannot skip locks.
// The workflow performs no feedback fetch, upload, delivery or timer operation.
export const runLocalPipeline = (options: LocalPipelineOptions) => Effect.scoped(Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const profile = yield* Profile;
  const root = yield* files.root(options.root);
  const id = yield* decodeProfileId(options.profileId);

  // Reject an unready standalone profile without creating lock files.
  // Only a load under the lock can supply inputs to this run.
  if (options.installationLease === undefined && (yield* profile.inspect(root, id)).readiness !== "ready") {
    return notStarted("Profile is not ready.");
  }

  yield* acquirePipelineLocks(root, id, options.installationLease);
  const selected = yield* profile.load(root, id);
  const { paths } = selected.bundle;

  // Do not write a refused run record into an unverified profile tree.
  if (process.platform === "win32" && !(yield* verifyWindowsPrivateSqlite(paths.directory, paths.review_db).pipe(
    Effect.as(true), Effect.orElseSucceed(() => false),
  ))) return notStarted("Cannot verify private Windows Judge state permissions.");

  const records = yield* pipelineRecords(root, join(selected.bundle.paths.directory, "local-pipeline-run.json"), selected.bundle.profile_id);
  // Retries start with a new source read. Keep only the read for the attempt that captures.
  let navEvents: number | undefined;
  const collection = yield* collectionStages(root, () => selected, options.onProgress, (count) => { navEvents = count; });
  const review = pipelineReview(root, selected, undefined, options.onProgress);
  const snapshot = yield* snapshotStage(selected, review.admittedModels, yield* ntfyEnabled(root), () => navEvents);

  return yield* runLockedPipeline({
    profileId: selected.bundle.profile_id, reviewerId: null,
    reset: options.reset ?? false, once: options.once ?? false,
    newRunId: () => crypto.randomUUID().replaceAll("-", ""), records,
    preflight: review.preflight, stages: [...collection, review.stage, snapshot],
    onProgress: options.onProgress,
  });
})).pipe(
  Effect.catchTag("ProfileError", () => Effect.succeed(notStarted("Profile is not ready."))),
  Effect.catchTag("WorkflowLockError", (error) => Effect.succeed(error.code === "busy" ? {
    status: "busy", run_id: null, stage: null, next_attempt_at: null, exitCode: 75, warnings: ["Another run holds an installation or profile lock."],
  } satisfies PipelineOutput : notStarted("Cannot acquire the pipeline locks."))),
  Effect.catchTag("PipelineError", () => Effect.succeed(notStarted("Cannot use the local pipeline run record."))),
);
