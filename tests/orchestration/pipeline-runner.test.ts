import { BunContext } from "@effect/platform-bun";
import { Deferred, Effect, Exit, Fiber, TestClock, TestContext } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelSettings, Reviewer } from "../../src/lib/server/judge/reviewers.ts";
import { checkPipelineHarnessPlatform } from "../../src/lib/server/orchestration/pipeline-review.ts";
import { profileFilesLayer } from "../../src/lib/server/profile/files.ts";
import { stageNames, startRecord, type RunRecord, type StageResult } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { pipelineRecords } from "../../src/lib/server/orchestration/pipeline-records.ts";
import { runLockedPipeline, type LockedPipelineOptions, type PipelineStage } from "../../src/lib/server/orchestration/pipeline-runner.ts";

const ok = { returncode: 0, stdout: "", stderr: "" };
const temporary = { returncode: 75, stdout: "", stderr: "provider busy; token=private-value" };
const safeDetail = "provider busy; [redacted]";

const memoryRun = (initial: RunRecord | null = null) => {
  let saved = initial;
  const writes: RunRecord[] = [];

  const options: LockedPipelineOptions = {
    profileId: "test-profile",
    reviewerId: null,
    reset: false,
    once: true,
    newRunId: () => "a".repeat(32),
    records: {
      read: Effect.sync(() => saved),
      write: (record) => Effect.sync(() => {
        saved = record;
        writes.push(record);
      }),
    },
    preflight: () => Effect.succeed(ok),
    stages: stageNames.map((name) => ({ name, timeoutMillis: 1000, run: () => Effect.succeed(name === "market"
      ? { ...ok, market: { status: "disabled" } } : ok) })),
  };

  return { options, writes, saved: () => saved };
};

describe("locked pipeline runner", () => {
  it.each(["screen", "judge", "rejudge"] as const)("refuses macOS Pi for active %s before running any stage", async (step) => {
    const run = memoryRun();
    const claude: Reviewer = { id: "test", harness: "claude-code", provider: "anthropic", model: "test", effort: "low", batch_size: 1, max_budget_usd: null, timeout_seconds: 30 };

    const models: ModelSettings = {
      screen: claude, judge: claude, rejudge: claude, calibrate: claude, rejudgeOptions: { same_as_judge: false, levels: ["strong"] },
      [step]: { ...claude, harness: "pi" },
    };

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      preflight: () => checkPipelineHarnessPlatform(models, "darwin", true).pipe(Effect.match({
        onSuccess: () => ok, onFailure: (error) => ({ ...ok, returncode: 2, stderr: error.code }),
      })),
      stages: run.options.stages.map((stage) => ({ ...stage, run: () => Effect.die("no stages may run") })),
    }));

    expect(result.exitCode).toBe(2);
    expect(run.saved()?.failure_detail).toBe("macos_pi_readiness_unavailable");
    await expect(Effect.runPromise(checkPipelineHarnessPlatform(models, "linux", true))).resolves.toBeUndefined();
    await expect(Effect.runPromise(checkPipelineHarnessPlatform({ ...models, [step]: claude }, "darwin", true))).resolves.toBeUndefined();

    if (step === "rejudge") {
      const inactive = { ...models, rejudgeOptions: { same_as_judge: false, levels: [] } };
      await expect(Effect.runPromise(checkPipelineHarnessPlatform(inactive, "darwin", true))).resolves.toBeUndefined();
    }
  });

  // Record writes in this case use real Windows ACL probes across three runs.
  it("persists a sanitized retry, resumes from sync, tolerates market failure and starts a new lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "pulse-runner-"));
    const path = join(root, "run.json");
    const calls: string[] = [];
    let failReview = true;
    let id = 0;

    try {
      const program = Effect.gen(function* () {
        const records = yield* pipelineRecords(root, path, "test-profile");

        const stages: PipelineStage[] = stageNames.map((name) => ({
          name,
          timeoutMillis: 1000,
          run: () => Effect.sync(() => {
            calls.push(name);

            if (name === "review" && failReview) {
              failReview = false;

              return temporary;
            }

            return name === "market" ? temporary : ok;
          }),
        }));

        const options = {
          profileId: "test-profile", reviewerId: null, reset: false, once: true,
          newRunId: () => (++id).toString(16).padStart(32, "0"), records,
          preflight: () => Effect.succeed(ok), stages,
        };

        const first = yield* runLockedPipeline(options);
        expect(first).toMatchObject({ status: "waiting", exitCode: 75, warnings: ["market stage failed"] });
        const saved = yield* records.read;
        expect(saved).toMatchObject({
          failed_attempts: 1, failure_detail: safeDetail,
          stage_results: { "sync-source": "succeeded", "resolve-locations": "succeeded", market: "failed", review: "failed" },
        });
        expect(saved).not.toBeNull();
        expect(saved?.ended_at).toBeUndefined();
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).not.toContain("private-value");

        if (saved === null) throw new Error("missing record");
        yield* records.write({ ...saved, next_attempt_at: "2000-01-01T00:00:00Z" });
        calls.length = 0;
        const second = yield* runLockedPipeline(options);
        expect(second).toMatchObject({ status: "completed", exitCode: 0 });
        expect(calls).toEqual(stageNames);
        const completed = yield* records.read;
        expect(completed?.failed_attempts).toBe(1);
        yield* runLockedPipeline(options);
        expect((yield* records.read)?.previous_run_id).toBe(completed?.run_id);
      });

      await Effect.runPromise(program.pipe(Effect.provide(profileFilesLayer(Effect.succeed(root))), Effect.provide(BunContext.layer)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 70_000 : undefined);

  it("keeps the last successful Market recording across a later skipped run", async () => {
    const run = memoryRun();
    const captured_at = "2026-11-19T12:00:00.000000+00:00";
    const last_market_recording = { captured_at, run_id: "a".repeat(32) };

    const stages = run.options.stages.map((stage) => stage.name === "market"
      ? { ...stage, run: () => Effect.succeed({ ...ok, market: { status: "recorded" as const, captured_at } }) }
      : stage);

    const result = await Effect.runPromise(runLockedPipeline({ ...run.options, stages }));
    expect(result.warnings).toEqual([]);
    expect(run.saved()).toMatchObject({
      last_market_recording, stage_results: {
        "sync-source": "succeeded", "resolve-locations": "succeeded", market: "recorded", review: "succeeded", snapshot: "succeeded",
      },
    });

    const skipped = await Effect.runPromise(runLockedPipeline({ ...run.options, newRunId: () => "b".repeat(32) }));
    expect(skipped).toMatchObject({ status: "completed", warnings: [] });
    expect(run.saved()).toMatchObject({ last_market_recording, stage_results: { market: "skipped" } });
  });

  it("reports a companion JSON warning without making a saved capture fail", async () => {
    const run = memoryRun();
    const warning = "Snapshot captured, but companion JSON export failed; an older JSON file may remain.";

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      stages: run.options.stages.map((stage) => stage.name === "snapshot"
        ? { ...stage, run: () => Effect.succeed({ ...ok, warnings: [warning] }) }
        : stage),
    }));

    expect(result).toMatchObject({ status: "completed", exitCode: 0, warnings: [warning] });
    expect(run.saved()).toMatchObject({ status: "completed", failed_attempts: 0 });
  });

  it("treats a stage timeout as temporary and rechecks preflight after the wait", async () => {
    const run = memoryRun();
    let preflights = 0;
    const calls: string[] = [];

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(runLockedPipeline({
        ...run.options,
        once: false,
        preflight: () => Effect.sync(() => {
          preflights++;

          return preflights === 1 ? ok : temporary;
        }),
        stages: stageNames.map((name) => ({
          name,
          timeoutMillis: 10,
          run: () => {
            calls.push(name);

            return name === "sync-source" ? Effect.never : Effect.succeed(ok);
          },
        })),
      }));

      yield* TestClock.adjust(10);
      expect(run.saved()).toMatchObject({ status: "waiting", last_outcome: "temporary sync-source: timeout", failure_detail: null });
      yield* TestClock.adjust(300_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "failed", exitCode: 2 });
      expect(preflights).toBe(2);
      expect(calls).toEqual(["sync-source"]);
      expect(run.saved()).toMatchObject({ failed_attempts: 1, status: "failed", failure_detail: safeDetail });
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
  });

  it("limits preflight to 120 seconds, finalizes its scope and persists a refusal without running stages", async () => {
    const run = memoryRun();
    let released = false;
    let ranStage = false;

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(runLockedPipeline({
        ...run.options,
        preflight: () => Effect.acquireUseRelease(
          Effect.void,
          () => Effect.never,
          () => Effect.sync(() => { released = true; }),
        ),
        stages: run.options.stages.map((stage) => ({
          ...stage,
          run: () => Effect.sync(() => {
            ranStage = true;

            return ok;
          }),
        })),
      }));

      yield* TestClock.adjust(119_999);
      expect(run.writes).toEqual([]);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "failed", exitCode: 2 });
      expect(released).toBe(true);
      expect(ranStage).toBe(false);
      expect(run.saved()).toMatchObject({ last_outcome: "refused before stages: review preflight could not run", failure_detail: null });
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
  });

  it.each([
    { stderr: temporary.stderr, stdout: "fallback reason", detail: safeDetail },
    { stderr: "", stdout: "review unavailable; password=private-value", detail: "review unavailable; [redacted]" },
  ])("preserves bounded sanitized preflight diagnosis with stderr preferred: $detail", async ({ stderr, stdout, detail }) => {
    const run = memoryRun();

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      preflight: () => Effect.succeed({ returncode: 75, stdout, stderr }),
    }));

    expect(result).toMatchObject({ status: "failed", exitCode: 2 });
    expect(run.saved()).toMatchObject({ last_outcome: "refused before stages: review preflight refused (exit 75)", failure_detail: detail });
    expect(JSON.stringify(run.writes)).not.toContain("private-value");
  });

  it("refuses a preflight executor failure without saving its private error", async () => {
    const run = memoryRun();

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      preflight: () => Effect.fail("password=private-value"),
    }));

    expect(result.exitCode).toBe(2);
    expect(run.saved()).toMatchObject({ last_outcome: "refused before stages: review preflight could not run", failure_detail: null });
    expect(JSON.stringify(run.writes)).not.toContain("private-value");
  });

  it.each(["preflight", "stage"] as const)("refuses a malformed %s executor result instead of treating it as success", async (phase) => {
    const run = memoryRun();
    // SAFETY: Deliberately omit stderr to test rejection at the injected executor boundary.
    const invalid = { returncode: 0, stdout: "" } as StageResult;

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      preflight: () => Effect.succeed(phase === "preflight" ? invalid : ok),
      stages: run.options.stages.map((stage) => ({ ...stage, run: () => Effect.succeed(invalid) })),
    }));

    expect(result.exitCode).toBe(2);
    expect(run.saved()).toMatchObject({
      status: "failed", failed_attempts: 0, failure_detail: null,
      last_outcome: phase === "preflight"
        ? "refused before stages: review preflight could not run"
        : "permanent sync-source: invalid executor result",
    });
  });

  it("persists a failed refusal for a saved retry more than five hours away", async () => {
    const previous = {
      ...startRecord(null, { profileId: "test-profile", reviewerId: "judge", runId: "b".repeat(32), reset: false, now: "1970-01-01T00:00:00Z" }),
      status: "waiting" as const,
      stage: "review" as const,
      failed_attempts: 1,
      next_attempt_at: "1970-01-01T06:00:00Z",
    };

    const run = memoryRun(previous);

    const result = await Effect.runPromise(runLockedPipeline(run.options).pipe(Effect.provide(TestContext.TestContext)));

    expect(result).toMatchObject({ status: "failed", exitCode: 2, run_id: previous.run_id });
    expect(run.saved()).toMatchObject({
      status: "failed", next_attempt_at: null, failed_attempts: 1,
      last_outcome: "refused before stages: next_attempt_at is more than 5 hours away; record is invalid",
    });
  });

  it("treats stage Effect failures as permanent executor errors without persisting the error", async () => {
    const run = memoryRun();

    const result = await Effect.runPromise(runLockedPipeline({
      ...run.options,
      stages: run.options.stages.map((stage) => ({ ...stage, run: () => Effect.fail("token=private-value") })),
    }));

    expect(result.exitCode).toBe(2);
    expect(run.saved()).toMatchObject({ status: "failed", failed_attempts: 0, last_outcome: "permanent sync-source: executor error", failure_detail: null });
  });

  it.each(["preflight", "stage"] as const)("propagates interruption during %s so the injected lock owner releases", async (phase) => {
    const run = memoryRun();
    let released = false;

    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const pending = Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never));

      const fiber = yield* Effect.fork(Effect.scoped(Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => { released = true; }));

        return yield* runLockedPipeline({
          ...run.options,
          preflight: () => phase === "preflight" ? pending : Effect.succeed(ok),
          stages: run.options.stages.map((stage) => ({ ...stage, run: () => pending })),
        });
      })));

      yield* Deferred.await(started);
      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(released).toBe(true);
      expect(run.saved()?.status ?? null).toBe(phase === "stage" ? "running" : null);
      expect(run.writes.every((record) => record.failed_attempts === 0)).toBe(true);
    });

    await Effect.runPromise(program);
  });

  it("refuses malformed state without writing or invoking preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "pulse-runner-"));
    const path = join(root, "run.json");

    try {
      await writeFile(path, "{broken");
      let invoked = false;

      const program = Effect.gen(function* () {
        const records = yield* pipelineRecords(root, path, "test-profile");

        return yield* Effect.either(runLockedPipeline({
          ...memoryRun().options,
          records,
          preflight: () => Effect.sync(() => {
            invoked = true;

            return ok;
          }),
        }));
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(profileFilesLayer(Effect.succeed(root))), Effect.provide(BunContext.layer)));
      expect(result._tag).toBe("Left");
      expect(invoked).toBe(false);
      expect(await readFile(path, "utf8")).toBe("{broken");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
