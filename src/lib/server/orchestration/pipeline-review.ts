import { FileSystem } from "@effect/platform";
import { Effect, Predicate, Schema } from "effect";
import { dirname } from "node:path";
import type { PipelineDetail, PipelineProgress } from "../../contracts/pipeline-progress.ts";
import { MAX_MODEL_CALLS_PER_RUN, PERMANENT_MODEL_UNKNOWN } from "../judge/core.ts";
import { HarnessReadiness } from "../judge/harness-readiness.ts";
import { piUsesOldNode } from "../judge/reviewer-detect.ts";
import { ReviewerSettings, hangTimeoutSeconds, rejudgeOptions, rejudgeReviewer, type ModelSettings, type Reviewer } from "../judge/reviewers.ts";
import { ReviewHost } from "../judge/run-information.ts";
import { verifyWindowsWritableSqlite } from "../shared/windows-private-files.ts";
import { prepareReviewSession } from "../judge/workflow-controller.ts";
import { runReviewSession } from "../judge/workflow-driver.ts";
import { WorkflowError } from "../judge/workflow-errors.ts";
import type { ReviewEvent } from "../judge/workflow-receipt.ts";
import type { ReviewSessionOptions } from "../judge/workflow-service.ts";
import type { LoadedProfile } from "../profile/service.ts";
import type { StageResult } from "./pipeline-core.ts";
import { ReviewProfileLockLive } from "./workflow-locks.ts";

const maxRuns = 200;
const reviewTimeoutMillis = 2 * maxRuns * (MAX_MODEL_CALLS_PER_RUN * hangTimeoutSeconds + 1000) * 1000;
const result = (returncode: number, stderr = ""): StageResult => ({ returncode, stdout: "", stderr });
const fail = (code: string) => new WorkflowError({ code });
const temporaryCodes = new Set(["source_temporary", "provider_temporary", "profile_workflow_busy"]);

const nonnegativeCount = Schema.is(Schema.Int.pipe(Schema.nonNegative()));

const count = (event: ReviewEvent, key: string): number => {
  const value = event[key];

  return nonnegativeCount(value) ? value : 0;
};

const mayContinue = (event: ReviewEvent, submitted: number): boolean => {
  if (event["type"] === "budget_exhausted") return true; // The driver superseded this exact run under its lock.

  if (event["type"] !== "complete") return false;
  const completed = count(event, "completed_count") + count(event, "screened_out_count");
  const status = event["status"];

  if (status === "completed") return completed > 0 && completed === count(event, "candidate_count");

  return (status === "superseded" || status === "failed") && (completed > 0 || submitted > 0 || count(event, "not_reviewed_count") > 0);
};

export const macPiUnavailable = "Use Claude Code for all active review steps on macOS. Pi readiness requires Linux.";
export const piNodeTooOld = "Pi could not start: Node is too old. Use a supported Node version and reinstall the desktop launcher if you use it.";

export const checkPipelineHarnessPlatform = (models: ModelSettings, platform: NodeJS.Platform, includeRejudge: boolean): Effect.Effect<void, WorkflowError> => {
  const reviewers = [models.screen, models.judge];

  if (includeRejudge && rejudgeOptions(models).levels.length > 0) reviewers.push(rejudgeReviewer(models));

  return platform === "darwin" && reviewers.some(({ harness }) => harness === "pi")
    ? Effect.fail(fail("macos_pi_readiness_unavailable")) : Effect.void;
};

const preflight = (root: string, profile: LoadedProfile, reviewerId: string, rereview?: ReviewSessionOptions["rereview"]) => Effect.gen(function* () {
  if (reviewerId !== "judge") return yield* fail("saved_reviewer_not_supported");
  const fs = yield* FileSystem.FileSystem;
  const { bundle } = profile;
  yield* fs.access(bundle.paths.directory, { writable: true }).pipe(Effect.mapError(() => fail("profile_directory_not_writable")));
  yield* fs.access(dirname(bundle.paths.source_db), { writable: true }).pipe(Effect.mapError(() => fail("source_directory_not_writable")));

  if (process.platform === "win32") yield* verifyWindowsWritableSqlite(bundle.paths.directory, bundle.paths.review_db).pipe(
    Effect.mapError(() => fail("judge_permissions_unverified")),
  );

  const modelSettings = yield* (yield* ReviewerSettings).load(root);
  yield* checkPipelineHarnessPlatform(modelSettings, process.platform, rereview === undefined);
  const host = yield* (yield* ReviewHost).name;
  const base = { context: { root, profile: bundle }, reviewer: modelSettings.judge, modelSettings, host, reviewAll: true, readOnlySource: true } satisfies ReviewSessionOptions;
  const options: ReviewSessionOptions = rereview === undefined ? { ...base, refreshReview: true } : { ...base, rereview };
  const repeat: ReviewSessionOptions | null = rereview === undefined && rejudgeOptions(modelSettings).levels.length ? { ...base, rejudge: true } : null;
  yield* prepareReviewSession(options);
  const readiness = yield* HarnessReadiness;
  const screen = yield* readiness.check(modelSettings.screen);
  const judge = yield* readiness.check(modelSettings.judge);

  if (modelSettings.screen.harness === modelSettings.judge.harness && screen !== judge) return yield* fail("harness_path_changed");
  const executables = new Map([[modelSettings.screen.harness, screen], [modelSettings.judge.harness, judge]]);

  if (repeat !== null) {
    yield* prepareReviewSession(repeat);
    const reviewer = rejudgeReviewer(modelSettings);

    if (!rejudgeOptions(modelSettings).same_as_judge) {
      const executable = yield* readiness.check(reviewer);
      const previous = executables.get(reviewer.harness);

      if (previous !== undefined && previous !== executable) return yield* fail("harness_path_changed");
      executables.set(reviewer.harness, executable);
    }
  }

  return { options, executables, repeat };
});

type CheckedReview = Effect.Effect.Success<ReturnType<typeof preflight>>;

const reviewAll = (options: ReviewSessionOptions, executables: CheckedReview["executables"], report: (detail: PipelineDetail) => Effect.Effect<void>) => Effect.gen(function* () {
  const seen = new Set<string>();
  const batches = { screen: 0, judge: 0, rejudge: 0 };

  for (let iteration = 0; iteration < maxRuns; iteration++) {
    let submitted = 0;
    let screenedOut = 0;

    const event = yield* runReviewSession(options, {
      executableFor: (harness: Reviewer["harness"]) => {
        const executable = executables.get(harness);

        return executable === undefined ? Effect.fail(fail("harness_not_checked")) : Effect.succeed(executable);
      },
      onEvent: (value) => Effect.gen(function* () {
        if (value["type"] === "submitted") submitted++;

        if (options.rejudge) return;

        const total = value["local_eligible_count"];

        if (iteration === 0 && nonnegativeCount(total) && (value["type"] === "ready" || value["status"] === "no_pending_candidates")) {
          yield* report({ kind: "eligible-jobs", count: total });
        }

        const next = count(value, "screened_out_count");

        if (value["type"] === "ready") screenedOut = next;

        if (next <= screenedOut) return;
        const added = next - screenedOut;
        screenedOut = next;
        yield* report({ kind: "screened-out", count: added });
      }),
      onBatch: (stage, count) => {
        const step = options.rejudge ? "rejudge" : stage === "title_screen" ? "screen" : "judge";

        return report({ kind: "review-batch", step, batch: ++batches[step], count });
      },
      retry: () => Effect.succeed("pause"),
    }).pipe(Effect.provide(ReviewProfileLockLive));

    if (event["type"] === "complete" && event["status"] === "no_pending_candidates") return result(0);
    const runId = event["run_id"];

    if (event["type"] === "blocked") {
      if (event["status"] === "open_run_review_scope_mismatch") return result(2, "Resume the open review with its original command and selection.");

      if (event["status"] === "source_refresh_required" && options.rereview !== undefined) return result(2, "Saved source is not current. Run pulse refresh first.");

      return result(2, "Review was blocked.");
    }

    const interruptedRejudge = options.rejudge && event["type"] === "complete" && event["status"] !== "completed";

    if (interruptedRejudge || !Predicate.isString(runId) || seen.has(runId) || !mayContinue(event, submitted)) return result(2, "Review stopped before the eligible pool was resolved.");
    seen.add(runId);
  }

  return result(2, "Review reached the run limit without finishing.");
}).pipe(Effect.catchAll((error) => {
  if (error instanceof WorkflowError && temporaryCodes.has(error.code)) return Effect.succeed(result(75, `Review stopped (${error.code}).`));

  if (error instanceof WorkflowError && error.code === "rejudge_attempts_blocked") return Effect.succeed(result(2, "The prior re-judge attempt cannot be retried with the same inputs."));

  return Effect.succeed(result(2, error instanceof WorkflowError && error.code === PERMANENT_MODEL_UNKNOWN ? "Review outcome is unknown and was not retried." : "Review could not finish."));
}));

export const pipelineReview = (root: string, selected: LoadedProfile, rereview?: ReviewSessionOptions["rereview"], onProgress?: (event: PipelineProgress) => Effect.Effect<void>) => {
  const report = (detail: PipelineDetail) => onProgress?.({ phase: "detail", detail }) ?? Effect.void;
  let admitted: CheckedReview | null = null;

  return {
    admittedModels: () => admitted?.options.modelSettings ?? null,
    preflight: (reviewerId: string) => Effect.gen(function* () {
      admitted = null;
      admitted = yield* preflight(root, selected, reviewerId, rereview);

      return result(0);
    }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
      if (error.code === "macos_pi_readiness_unavailable") return result(2, macPiUnavailable);

      if (error.code === "pi_not_ready" && process.platform === "linux") {
        const pi = Bun.which("pi");

        if (pi !== null && (yield* Effect.promise((signal) => piUsesOldNode(pi, undefined, signal)))) {
          return result(2, piNodeTooOld);
        }
      }

      return result(2, `Review preflight failed (${error.code}).`);
    }))),
    stage: {
      name: "review" as const, timeoutMillis: reviewTimeoutMillis,
      run: () => Effect.gen(function* () {
        if (admitted === null) return result(2, "Review needs a successful preflight.");
        const { options, executables, repeat } = admitted;
        const first = yield* reviewAll(options, executables, report);

        if (first.returncode !== 0 || repeat === null) return first;
        yield* report({ kind: "rejudge-started" });
        const second = yield* reviewAll(repeat, executables, report);

        return second.returncode === 0 ? second : result(second.returncode, `Re-judge stopped. ${second.stderr}`);
      }),
    },
  };
};
