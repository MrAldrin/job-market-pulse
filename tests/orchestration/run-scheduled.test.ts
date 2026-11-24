import { expect, test } from "vitest";
import { FileSystem } from "@effect/platform";
import { Deferred, Effect, Either, Exit, Fiber } from "effect";
import { join } from "node:path";
import { run, syntheticSplit } from "../profile/fixtures.ts";
import { completedRecord, startRecord } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { pipelineRecords } from "../../src/lib/server/orchestration/pipeline-records.ts";
import { runScheduled } from "../../src/lib/server/orchestration/run-scheduled.ts";
import { latestScheduledRun } from "../../src/lib/server/orchestration/scheduled-runs.ts";
import { acquirePipelineLocks, withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";

const id = "a".repeat(32);
const neverRefresh = () => Effect.die("unexpected refresh");

test("due gate, invalid schedule and busy lock", async () => {
  await run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    let alerts = 0;

    const options = {
      root: fixture.root, profileId: "invented", onlyIfDue: true, refresh: neverRefresh,
      alertFailure: () => Effect.sync(() => { alerts++; }),
    };

    expect(yield* runScheduled({ ...options, period: "every 90 days", anchor: "9999-01-01" })).toBe(0);
    expect(yield* fs.exists(join(fixture.directory, "scheduled-runs.sqlite3"))).toBe(false);
    expect(alerts).toBe(0);
    expect(yield* fs.exists(join(fixture.root, "data", ".local-pipeline-installation.lock"))).toBe(false);
    expect(yield* runScheduled({ ...options, period: "invalid" })).toBe(2);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("schedule");
    const code = yield* withInstallationLock(fixture.root, () => runScheduled({ ...options, onlyIfDue: false, period: "daily" }));
    expect(code).toBe(75);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("lock");
    expect(alerts).toBe(2);
  }));
});

test("requires exactly one persisted completed ID and retains lease for refresh", async () => {
  await run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const alerts: string[] = [];

    const options = {
      root: fixture.root, profileId: "invented", onlyIfDue: false, period: "daily",
      prepareAlert: () => Effect.succeed(Effect.sync(() => { alerts.push("ok"); })),
      alertFailure: () => Effect.sync(() => { alerts.push("failure"); }),
    };

    const records = yield* pipelineRecords(fixture.root, join(fixture.directory, "local-pipeline-run.json"), "invented");
    const saved = { ...startRecord(null, { profileId: "invented", reviewerId: "test", runId: id, reset: false, now: "2026-01-01T00:00:00Z" }), stage: "snapshot" as const };
    yield* records.write(saved);

    const refresh = (root: string, lease: Parameters<typeof acquirePipelineLocks>[2] & {}) => Effect.scoped(Effect.gen(function* () {
      yield* acquirePipelineLocks(root, "invented", lease);
      expect(yield* withInstallationLock(root, () => Effect.succeed(false)).pipe(Effect.catchAll(() => Effect.succeed(true)))).toBe(true);
      yield* records.write(completedRecord(saved));

      return { exitCode: 0, completionIds: [id] };
    }));

    expect(yield* runScheduled({ ...options, refresh })).toBe(0);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.status).toBe("ok");
    expect(alerts).toEqual(["ok"]);
    expect(yield* runScheduled({ ...options, refresh: () => Effect.succeed({ exitCode: 0, completionIds: [id] }) })).toBe(1);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("pipeline");
    expect(yield* runScheduled({ ...options, refresh: () => Effect.succeed({ exitCode: 0, completionIds: [id, id] }) })).toBe(1);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("runner");
    expect(yield* runScheduled({ ...options, refresh: () => Effect.succeed({ exitCode: 0, completionIds: ["b".repeat(32)] }) })).toBe(1);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("pipeline");
    expect(alerts).toEqual(["ok", "failure", "failure", "failure"]);
  }));
});

test.each([0, 2])("scheduled outcome %i and history are final before cancellable delivery", (code) => run(Effect.gen(function* () {
  const fixture = yield* syntheticSplit;
  const posting = yield* Deferred.make<void>();
  const notify = Deferred.succeed(posting, undefined).pipe(Effect.zipRight(Effect.never));
  const reports: number[] = [];
  const failures: Array<[string, number]> = [];

  const fiber = yield* Effect.fork(runScheduled({
    root: fixture.root, profileId: "invented", onlyIfDue: false, period: code === 0 ? "daily" : "invalid",
    prepareAlert: () => Effect.succeed(notify),
    alertFailure: () => notify,
    onFailure: (stage, result) => Effect.sync(() => { failures.push([stage, result]); }),
    reportResult: (result) => Effect.sync(() => { reports.push(result); }),
    refresh: () => Effect.gen(function* () {
      const records = yield* pipelineRecords(fixture.root, join(fixture.directory, "local-pipeline-run.json"), "invented");
      const record = startRecord(null, { profileId: "invented", reviewerId: "test", runId: id, reset: false, now: "2026-01-01T00:00:00Z" });
      yield* records.write(completedRecord({ ...record, stage: "snapshot" }));

      return { exitCode: 0, completionIds: [id] };
    }),
  }));

  yield* Deferred.await(posting);
  expect(reports).toEqual([code]);
  const history = yield* latestScheduledRun(fixture.root, "invented");
  expect(history?.status).toBe(code === 0 ? "ok" : "failed");
  expect(failures).toEqual(code === 0 ? [] : [["schedule", code]]);
  yield* Fiber.interrupt(fiber);
  expect(yield* latestScheduledRun(fixture.root, "invented")).toEqual(history);
  expect(failures).toEqual(code === 0 ? [] : [["schedule", code]]);
  expect(reports).toEqual([code]);
  expect(yield* withInstallationLock(fixture.root, () => Effect.succeed(true))).toBe(true);
})));

test("history write failure cannot report success", async () => {
  await run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;

    const result = yield* Effect.either(runScheduled({
      root: fixture.root, profileId: "invented", onlyIfDue: false, period: "daily",
      refresh: () => Effect.gen(function* () {
        const path = join(fixture.directory, "scheduled-runs.sqlite3");
        yield* fs.remove(path);
        yield* fs.makeDirectory(path);

        return { exitCode: 1, completionIds: [] };
      }),
    }));

    expect(result._tag).toBe("Left");
    expect(yield* withInstallationLock(fixture.root, () => Effect.succeed(true))).toBe(true);
  }));
});

test("successful refresh cannot recreate deleted scheduled history", async () => {
  await run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const path = join(fixture.directory, "scheduled-runs.sqlite3");

    const result = yield* Effect.either(runScheduled({
      root: fixture.root, profileId: "invented", onlyIfDue: false, period: "daily",
      refresh: (root, lease) => Effect.scoped(Effect.gen(function* () {
        yield* acquirePipelineLocks(root, "invented", lease);
        const records = yield* pipelineRecords(root, join(fixture.directory, "local-pipeline-run.json"), "invented");
        yield* records.write(completedRecord({ ...startRecord(null, { profileId: "invented", reviewerId: "test", runId: id, reset: false, now: "2026-01-01T00:00:00Z" }), stage: "snapshot" }));
        yield* fs.remove(path);

        return { exitCode: 0, completionIds: [id] };
      })),
    }));

    expect(Either.isLeft(result) || result.right !== 0).toBe(true);
    expect(yield* fs.exists(path)).toBe(false);
  }));
});

test("pending cancellation at the failure commit preserves history, stage and reported exit code", () => run(Effect.gen(function* () {
  const fixture = yield* syntheticSplit;
  const committing = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const reports: number[] = [];
  const stages: string[] = [];
  let alerted = false;

  const fiber = yield* Effect.fork(runScheduled({
    root: fixture.root, profileId: "invented", onlyIfDue: false, period: "daily",
    refresh: () => Effect.succeed({ exitCode: 2, completionIds: [], failedStage: "review" }),
    onFailure: (stage) => Effect.sync(() => { stages.push(stage); }).pipe(
      Effect.zipRight(Deferred.succeed(committing, undefined)), Effect.zipRight(Deferred.await(release)),
    ),
    reportResult: (code) => Effect.sync(() => { reports.push(code); }),
    alertFailure: () => Effect.sync(() => { alerted = true; }),
  }));

  yield* Deferred.await(committing);
  yield* fiber.interruptAsFork(yield* Effect.fiberId);
  yield* Deferred.succeed(release, undefined);
  expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
  expect(yield* latestScheduledRun(fixture.root, "invented")).toMatchObject({ status: "failed", failed_stage: "review" });
  expect(stages).toEqual(["review"]);
  expect(reports).toEqual([2]);
  expect(alerted).toBe(false);
  expect(yield* withInstallationLock(fixture.root, () => Effect.succeed(true))).toBe(true);
})));

test("interruption and callback errors save fixed history and release the lock", async () => {
  await run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const entered = yield* Deferred.make<void>();
    const options = { root: fixture.root, profileId: "invented", onlyIfDue: false, period: "daily" };
    const fiber = yield* Effect.fork(runScheduled({ ...options, refresh: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)) }));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.failed_stage).toBe("interrupted");
    expect(yield* runScheduled({ ...options, refresh: () => Effect.fail("secret") })).toBe(1);
    expect((yield* latestScheduledRun(fixture.root, "invented"))?.error).toBe("Scheduled refresh could not finish.");
  }));
});
