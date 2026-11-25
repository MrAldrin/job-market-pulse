import { syntheticServeOrigin } from "../shared/serve-hosts.ts";
import { BunContext } from "@effect/platform-bun";
import { Deferred, Effect, FiberId, Layer, Redacted, Schema, TestClock, TestContext } from "effect";
import fc from "fast-check";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { CheckoutRefresh } from "../../src/cli/pulse-refresh.ts";
import { LocalRunStart, LocalRunStatusResponse, localRunLogLimit, localRunStartPath, localRunStatusPath } from "../../src/lib/contracts/local-run.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { serveIdentity } from "../../src/lib/server/dashboard/auth.ts";
import { dashboardConfigTest, type DashboardSettings } from "../../src/lib/server/dashboard/config.ts";
import { desktopClosePath } from "../../src/lib/server/dashboard/run-response.ts";
import { DashboardRunLive } from "../../src/lib/server/dashboard/run.ts";
import { DashboardServer, DashboardServerLive } from "../../src/lib/server/dashboard/service.ts";
import { DashboardSnapshot } from "../../src/lib/server/dashboard/snapshot.ts";
import { completedRecord, stageNames, startRecord, type RunRecord } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { pipelineRecords } from "../../src/lib/server/orchestration/pipeline-records.ts";
import { macPiUnavailable, piNodeTooOld } from "../../src/lib/server/orchestration/pipeline-review.ts";
import { runLockedPipeline } from "../../src/lib/server/orchestration/pipeline-runner.ts";
import * as diagnostics from "../../src/lib/server/orchestration/windows-failure-report.ts";
import { requireInstallationLease, withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { LocalProfileSettings } from "../../src/lib/server/profile/local-settings.ts";
import { packageConfigPath } from "../../src/lib/server/shared/paths.ts";

const profileId = "invented";
const host = "127.0.0.1:8770";
const origin = `http://${host}`;
const runId = "a".repeat(32);
const stamp = "2026-11-19T12:00:00.000Z";
const success = { exitCode: 0, completionIds: [runId] };
const initial = () => startRecord(null, { profileId, reviewerId: "judge", runId, reset: false, now: stamp });
const noSnapshot = Effect.succeed(null);
const unexpected = () => Effect.dieMessage("Unexpected call in offline run test");
const files = ProfileFilesLive.pipe(Layer.provideMerge(BunContext.layer));

const config = (root: string, mode: DashboardSettings["mode"] = "local", selected = true): DashboardSettings => {
  const common = {
    mode, port: 8770, allowedHosts: [host], dataDir: root, snapshotFile: null, snapshotDb: join(root, "digest.sqlite"),
    feedbackDb: join(root, "feedback.sqlite"), feedbackProfile: null, starred: null, login: null,
  };

  return selected ? { ...common, localSettings: { root, profileId } } : common;
};

const fixture = (settings: DashboardSettings, refresh: CheckoutRefresh["Type"]["run"] = unexpected) => DashboardServerLive.pipe(
  Layer.provide(dashboardConfigTest(settings)),
  Layer.provide(Layer.succeed(DashboardSnapshot, { readDocument: noSnapshot, readJson: noSnapshot, readFeedbackContext: noSnapshot })),
  Layer.provide(Layer.succeed(LocalProfileSettings, { read: unexpected, save: unexpected, refreshModels: unexpected, testModel: unexpected })),
  Layer.provide(DashboardRunLive.pipe(Layer.provide(Layer.succeed(CheckoutRefresh, { run: refresh })), Layer.provide(files), Layer.provide(dashboardConfigTest(settings)))),
);

const desktopToken = "c".repeat(64);
const desktopConfig = (root: string) => ({ ...config(root), desktopCloseToken: Redacted.make(desktopToken) });

const desktopClose = (sequence: number, method = "POST", changes?: HeadersInit) => {
  const headers = new Headers({ "x-pulse-desktop-token": desktopToken, "x-pulse-close-sequence": String(sequence) });
  new Headers(changes).forEach((value, key) => { headers.set(key, value); });

  return request(desktopClosePath, method, headers);
};

const withRoot = async (use: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "pulse-dashboard-run-"));

  try { await use(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const request = (path: string, method = "GET", overrides?: HeadersInit, body?: string) => {
  const headers = new Headers({ host });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  new Headers(overrides).forEach((value, key) => { headers.set(key, value); });

  return new Request(origin + path, body === undefined ? { method, headers } : { method, headers, body });
};

const decode = Schema.decodeUnknownSync(LocalRunStatusResponse, { onExcessProperty: "error" });

const client = (server: DashboardServer["Type"], socketAddress = "127.0.0.1") => {
  const send = (request: Request) => server.handle({ request, socketAddress });

  const status = send(request(localRunStatusPath)).pipe(Effect.flatMap((response) => Effect.promise(async () => {
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");

    return decode(await response?.json());
  })));

  const start = (csrf: string, body = '{"confirm":true}', changes?: Record<string, string>) =>
    send(request(localRunStartPath, "POST", { origin, "x-csrf-token": csrf, ...changes }, body));

  return { send, status, start };
};

const waitForFinish = (readStatus: ReturnType<typeof client>["status"], deadlineMillis = 2_000) => Effect.gen(function* () {
  let state = yield* readStatus;

  while (state.status === "running") {
    yield* Effect.sleep("5 millis");
    state = yield* readStatus;
  }

  return state;
}).pipe(Effect.timeout(deadlineMillis));

test("only an exact positive confirmation is valid", () => {
  const decodeStart = decodeStrict(LocalRunStart);
  expect(decodeStart({ confirm: true })._tag).toBe("Right");
  expect(decodeStart({ confirm: true, reset_run_id: runId })._tag).toBe("Right");
  expect(decodeStart({ confirm: true, reset_run_id: "wrong" })._tag).toBe("Left");
  expect(decodeStart({ confirm: true, reset_run_id: true })._tag).toBe("Left");
  fc.assert(fc.property(fc.string().filter((key) => key !== "confirm" && key !== "reset_run_id"), fc.jsonValue(), (key, value) => {
    expect(decodeStart({ confirm: true, [key]: value })._tag).toBe("Left");

    if (value !== true) expect(decodeStart({ confirm: value })._tag).toBe("Left");
  }));
});

test("start rejects other hosts, origins, tokens, methods, queries and bodies before refresh", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const server = yield* DashboardServer;
  const { send, status, start } = client(server);
  const { csrf_token: token } = yield* status;

  expect(server.capabilities({ request: request(localRunStatusPath), socketAddress: "127.0.0.1" }).canRunRefresh).toBe(true);
  expect((yield* send(request(localRunStatusPath, "GET", { host: "other.test" })))?.status).toBe(403);
  expect((yield* start(token, undefined, { origin: "http://other.test" }))?.status).toBe(403);
  expect((yield* start(token, undefined, { origin: "" }))?.status).toBe(403);
  expect((yield* start("b".repeat(64)))?.status).toBe(403);
  expect((yield* start(token, '{"confirm":true,"profile":"alternate"}'))?.status).toBe(400);
  expect((yield* start(token, '{"confirm":true,"confirm":true}'))?.status).toBe(400);
  expect((yield* start(token, '{"confirm":false}'))?.status).toBe(400);
  expect((yield* start(token, " ".repeat(129)))?.status).toBe(413);
  expect((yield* send(request(localRunStatusPath + "?profile=other")))?.status).toBe(404);
  expect((yield* send(request(localRunStartPath)))?.status).toBe(405);
  expect((yield* send(request(localRunStatusPath, "POST")))?.status).toBe(405);
  const head = yield* send(request(localRunStatusPath, "HEAD"));
  expect(head?.status).toBe(200);
  expect(head?.body).toBeNull();
}).pipe(Effect.provide(fixture(config(root)))))));

test.each([["local", false, "127.0.0.1"], ["local", true, "192.0.2.1"], ["railway", true, "127.0.0.1"]] as const)(
  "hide both routes in %s with selected=%s from socket %s even with loopback forwarding headers",
  (mode, selected, address) => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const { send } = client(server, address);
    expect(server.capabilities({ request: request(localRunStatusPath), socketAddress: address }).canRunRefresh).toBe(false);
    const headers = { "x-forwarded-for": "127.0.0.1", origin };
    const status = mode === "local" && address === "127.0.0.1" ? 403 : 404;

    expect((yield* send(request(localRunStatusPath, "GET", headers)))?.status).toBe(status);
    expect((yield* send(request(localRunStartPath, "POST", headers, '{"confirm":true}')))?.status).toBe(status);
  }).pipe(Effect.provide(fixture(config(root, mode, selected)))))),
);

test("desktop close is private and blocks loopback and Serve starts until cancel", () => withRoot((root) => {
  const serve = serveIdentity(syntheticServeOrigin, "invented@example.test")!;

  return Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const { send, status, start } = client(server);
    const token = (yield* status).csrf_token;

    const throughServe = (input: Request, body?: string) => {
      const headers = new Headers(input.headers);
      headers.set("host", serve.host);
      headers.set("origin", serve.origin);
      headers.set("x-forwarded-for", "100.64.0.10");
      headers.set("x-forwarded-proto", "https");
      headers.set("tailscale-user-login", serve.owner);

      return send(new Request(serve.origin + new URL(input.url).pathname, { method: input.method, headers, body: body ?? null }));
    };

    const body = '{"confirm":true}';
    const startFromPhone = () => throughServe(request(localRunStartPath, "POST", { "x-csrf-token": token }, body), body);

    expect((yield* send(desktopClose(1, "POST", { "x-pulse-desktop-token": token })))?.status).toBe(403);
    expect((yield* client(server, "192.0.2.1").send(desktopClose(1)))?.status).toBe(404);
    expect((yield* throughServe(desktopClose(1)))?.status).toBe(404);
    expect((yield* send(desktopClose(1, "GET")))?.status).toBe(405);
    expect((yield* send(desktopClose(1)))?.status).toBe(204);

    for (const denied of [yield* start(token), yield* startFromPhone()]) {
      expect(denied?.status).toBe(409);
      expect(yield* Effect.promise(async () => denied?.text())).toBe("The app is closing");
    }

    expect((yield* send(desktopClose(3, "DELETE")))?.status).toBe(204);
    expect((yield* send(desktopClose(2)))?.status).toBe(409);
    expect((yield* startFromPhone())?.status).toBe(202);
  }).pipe(Effect.provide(fixture({ ...desktopConfig(root), serve }, () => Effect.succeed(success)))));
}));

test("held installation lock returns 409; concurrent dashboard starts admit exactly one detached refresh", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const reachedMarket = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  let calls = 0;
  let record: RunRecord | null = null;

  const refresh: CheckoutRefresh["Type"]["run"] = (options) => Effect.gen(function* () {
    calls++;
    expect(options).toMatchObject({ root, id: profileId, noPublish: true });
    expect(options.railway()).toBeNull();
    expect(options.lease).toBeDefined();

    if (options.lease !== undefined) yield* requireInstallationLease(root, options.lease).pipe(Effect.orDie);
    const ok = { returncode: 0, stdout: "invented private stdout", stderr: "invented private stderr" };
    const report = options.onProgress ?? (() => Effect.void);

    const result = yield* runLockedPipeline({
      profileId, reviewerId: null, reset: false, once: false, newRunId: () => runId,
      records: { read: Effect.sync(() => record), write: (next) => Effect.sync(() => { record = next; }) },
      preflight: () => Effect.succeed(ok),
      stages: stageNames.map((name) => ({ name, timeoutMillis: 5000, run: () => Effect.gen(function* () {
        if (name === "market") return yield* Deferred.succeed(reachedMarket, undefined).pipe(
          Effect.zipRight(Deferred.await(resume)), Effect.as({ ...ok, returncode: 2 }),
        );

        if (name === "review") {
          yield* report({ phase: "detail", detail: { kind: "eligible-jobs", count: 321 } });
          yield* report({ phase: "detail", detail: { kind: "screened-out", count: 5 } });
          yield* report({ phase: "detail", detail: { kind: "review-batch", step: "judge", batch: 1, count: 12 } });
          yield* report({ phase: "detail", detail: { kind: "rejudge-started" } });
        }

        return ok;
      }) })),
      onProgress: options.onProgress,
    }).pipe(Effect.orDie);

    expect(result.status).toBe("completed");

    return success;
  });

  yield* Effect.gen(function* () {
    const { status, start } = client(yield* DashboardServer);
    const idle = yield* status;
    expect(idle.status).toBe("idle");
    const token = idle.csrf_token;
    const denied = yield* withInstallationLock(root, () => start(token));
    expect(denied?.status).toBe(409);
    expect(yield* Effect.promise(async () => denied?.text())).toBe("A run is already in progress");
    expect(calls).toBe(0);
    const starts = yield* Effect.all([start(token), start(token)], { concurrency: "unbounded" });
    expect(starts.map((response) => response?.status).sort()).toEqual([202, 409]);
    yield* Deferred.await(reachedMarket);
    expect(calls).toBe(1);
    expect(yield* status).toMatchObject({
      status: "running", started_at: expect.any(String), ended_at: null, current_stage: "market",
      stages: [
        { stage: "sync-source", status: "succeeded" }, { stage: "resolve-locations", status: "succeeded" },
        { stage: "market", status: "running" }, { stage: "review", status: "pending" }, { stage: "snapshot", status: "pending" },
      ],
    });
    const partial = (yield* status).log;
    expect(partial.map(({ message }) => message)).toEqual([
      "Refresh started.", "Checking refresh readiness.", "Reading NAV.", "Finished reading NAV.",
      "Resolving job locations.", "Finished resolving job locations.", "Recording market data.",
    ]);
    yield* Deferred.succeed(resume, undefined);
    const final = yield* waitForFinish(status);
    expect(final).toMatchObject({ status: "succeeded", ended_at: expect.any(String), current_stage: null, error: null });
    expect(final.log.slice(0, partial.length)).toEqual(partial);
    expect(final.log.slice(partial.length).map(({ message }) => message)).toEqual([
      "Stage failed.", "Preparing to review jobs.", "Jobs eligible after area, occupation and exclusion filters: 321.",
      "Jobs screened out by title: 5.", "Judge batch 1 started (12 jobs).", "Starting re-judge.", "Finished reviewing jobs.",
      "Saving the dashboard snapshot.", "Dashboard snapshot saved.", "Complete. The new data is in the dashboard.",
    ]);
    expect(final.log.map(({ sequence }) => sequence)).toEqual(final.log.map((_, index) => index + 1));
    expect(JSON.stringify(final)).not.toContain("invented private");
    expect(final.stages.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "failed", "succeeded", "succeeded"]);
    yield* withInstallationLock(root, () => Effect.void);

    // Simulate a later refresh outside the dashboard while its server stays open.
    const directory = join(root, "local_only", "profiles", profileId);
    const last_market_recording = { captured_at: stamp, run_id: "b".repeat(32) };
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "local-pipeline-run.json"), JSON.stringify(completedRecord({
        ...initial(), run_id: last_market_recording.run_id, stage: "snapshot", last_market_recording,
      })));
    });
    expect(yield* status).toMatchObject({ ended_at: final.ended_at, last_market_recording });
  }).pipe(Effect.provide(fixture(config(root), refresh)));
}))));

test("dashboard keeps a reported completion when shutdown cancels notification delivery", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const posting = yield* Deferred.make<void>();

  const refresh: CheckoutRefresh["Type"]["run"] = ({ reportCompleted }) =>
    (reportCompleted?.(success) ?? unexpected()).pipe(
      Effect.zipRight(Deferred.succeed(posting, undefined)),
      Effect.zipRight(Effect.never),
    );

  const statusAfterClose = yield* Effect.gen(function* () {
    const { status, start } = client(yield* DashboardServer);
    expect((yield* start((yield* status).csrf_token))?.status).toBe(202);
    yield* Deferred.await(posting);
    expect(yield* status).toMatchObject({ status: "succeeded", error: null });

    return status;
  }).pipe(Effect.provide(fixture(config(root), refresh)));

  expect(yield* statusAfterClose).toMatchObject({ status: "succeeded", error: null });
  expect(yield* withInstallationLock(root, () => Effect.succeed(true))).toBe(true);
}))));

test.each(["saved wait", "current retry"])("after %s, status clears the waiting stage during preflight", (kind) => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const checking = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const retryAt = new Date(300_000).toISOString();

  let record: RunRecord | null = kind === "saved wait" ? {
    ...initial(), stage: "sync-source", status: "waiting", failed_attempts: 1, next_attempt_at: retryAt,
  } : null;

  let checks = 0;
  const ok = { returncode: 0, stdout: "", stderr: "" };

  const refresh: CheckoutRefresh["Type"]["run"] = ({ onProgress }) => runLockedPipeline({
    profileId, reviewerId: null, reset: false, once: false, newRunId: () => runId,
    records: { read: Effect.sync(() => record), write: (next) => Effect.sync(() => { record = next; }) },
    preflight: () => Effect.suspend(() => ++checks === 1 ? Effect.succeed(ok)
      : Deferred.succeed(checking, undefined).pipe(Effect.zipRight(Deferred.await(release)), Effect.as(ok))),
    stages: stageNames.map((name) => ({ name, timeoutMillis: 1000, run: () => Effect.succeed({
      ...ok, returncode: name === "sync-source" && checks === 1 ? 75 : 0,
    }) })),
    onProgress,
  }).pipe(Effect.as(success), Effect.orDie);

  yield* Effect.gen(function* () {
    const { status, start } = client(yield* DashboardServer);
    expect((yield* start((yield* status).csrf_token))?.status).toBe(202);
    yield* TestClock.adjust(299_999);
    expect(yield* status).toMatchObject({ status: "running", current_stage: "sync-source", retry_at: expect.any(String) });
    yield* TestClock.adjust(1);
    yield* Deferred.await(checking);
    const preflight = yield* status;
    expect(preflight).toMatchObject({ status: "running", current_stage: null, retry_at: null });
    expect(preflight.stages.every((entry) => entry.status === "pending")).toBe(true);
    yield* Deferred.succeed(release, undefined);
  }).pipe(Effect.provide(fixture(config(root), refresh)));
}).pipe(Effect.provide(TestContext.TestContext)))));

test("server scope interruption runs the refresh finalizer and releases the installation lock", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const began = yield* Deferred.make<void>();
  let interrupted = false;
  const refresh = () => Deferred.succeed(began, undefined).pipe(Effect.zipRight(Effect.never), Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })));
  yield* Effect.gen(function* () {
    const { status, start } = client(yield* DashboardServer);
    expect((yield* start((yield* status).csrf_token))?.status).toBe(202);
    yield* Deferred.await(began);
  }).pipe(Effect.provide(fixture(config(root), refresh)));
  expect(interrupted).toBe(true);
  yield* withInstallationLock(root, () => Effect.void);
}))));

test("run log drops its oldest entries and starts empty on the next run", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  let calls = 0;

  const refresh: CheckoutRefresh["Type"]["run"] = ({ onProgress }) => Effect.gen(function* () {
    const report = onProgress ?? (() => Effect.void);

    if (++calls === 1) {
      for (let batch = 1; batch <= localRunLogLimit; batch++) {
        yield* report({ phase: "detail", detail: { kind: "review-batch", step: "judge", batch, count: 1 } });
      }

      yield* report({ phase: "detail", detail: { kind: "nav-events", count: Number.NaN } });
    }

    return success;
  });

  yield* Effect.gen(function* () {
    const { status, start } = client(yield* DashboardServer);
    const { csrf_token } = yield* status;
    expect((yield* start(csrf_token))?.status).toBe(202);
    const first = yield* waitForFinish(status);
    expect(first.log).toHaveLength(localRunLogLimit);
    expect(first.log[0]).toMatchObject({ sequence: 3, message: "Judge batch 2 started (1 job)." });
    expect(first.log.at(-1)).toMatchObject({ sequence: localRunLogLimit + 2, message: "Complete. The new data is in the dashboard." });
    expect((yield* start(csrf_token))?.status).toBe(202);
    expect((yield* waitForFinish(status)).log.map(({ sequence, message }) => [sequence, message])).toEqual([
      [1, "Refresh started."], [2, "Complete. The new data is in the dashboard."],
    ]);
  }).pipe(Effect.provide(fixture(config(root), refresh)));
}))));

test("failure after a retry wait keeps an end time and does not expose raw error text", () => withRoot((root) => Effect.runPromise(Effect.gen(function* () {
  const failure = yield* Deferred.make<void>();
  const waiting = yield* Deferred.make<void>();

  const refresh: CheckoutRefresh["Type"]["run"] = ({ onProgress }) => Effect.gen(function* () {
    if (onProgress !== undefined) yield* onProgress({ phase: "waiting", stage: "review", retryAt: stamp });
    yield* Deferred.succeed(waiting, undefined);
    yield* Deferred.await(failure);

    return yield* Effect.dieMessage("invented private error");
  });

  yield* Effect.gen(function* () {
    const { send, status, start } = client(yield* DashboardServer);
    const token = (yield* status).csrf_token;
    expect((yield* start(token))?.status).toBe(202);
    yield* Deferred.await(waiting);
    expect(yield* status).toMatchObject({ status: "running", current_stage: "review", retry_at: stamp });
    expect((yield* send(desktopClose(1)))?.status).toBe(200);
    const denied = yield* start(token);
    expect(yield* Effect.promise(async () => denied?.text())).toBe("The app is closing");
    expect((yield* send(desktopClose(2, "DELETE")))?.status).toBe(204);
    yield* Deferred.succeed(failure, undefined);
    const final = yield* waitForFinish(status);
    expect(final).toMatchObject({ status: "failed", current_stage: null, retry_at: null, ended_at: expect.any(String), error: expect.any(String) });
    expect(final.stages).toContainEqual({ stage: "review", status: "failed" });
    expect(final.log.at(-1)).toMatchObject({ time: final.ended_at, level: "error", message: final.error });
    expect(JSON.stringify(final)).not.toContain("invented private error");
  }).pipe(Effect.provide(fixture(desktopConfig(root), refresh)));
}))));

test("terminal status and a new run do not wait for the previous failure report", () => withRoot(async (root) => {
  const entered = Deferred.unsafeMake<void>(FiberId.none);
  const release = Deferred.unsafeMake<void>(FiberId.none);
  const reported = Deferred.unsafeMake<void>(FiberId.none);
  let attempts = 0;
  let reporters = 0;

  const refresh: CheckoutRefresh["Type"]["run"] = () => Effect.sync(() => ++attempts === 1 ? { exitCode: 2, completionIds: [] } : success);

  const diagnostic = vi.spyOn(diagnostics, "diagnoseWindowsFailure").mockImplementation(() => (worker) => Effect.onExit(worker, () => ++reporters !== 1 ? Effect.void
    : Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(release)), Effect.zipRight(Deferred.succeed(reported, undefined)))));

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const { status, start } = client(yield* DashboardServer);
      const token = (yield* status).csrf_token;
      expect((yield* start(token))?.status).toBe(202);
      yield* Deferred.await(entered);
      expect(yield* status).toMatchObject({ status: "failed", ended_at: expect.any(String) });
      expect((yield* start(token))?.status).toBe(202);
      expect(yield* waitForFinish(status)).toMatchObject({ status: "succeeded" });
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(reported);
      expect(yield* status).toMatchObject({ status: "succeeded" });
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(fixture(config(root), refresh))));
  } finally { diagnostic.mockRestore(); }
}));

// Recovery uses real record writes. Each private write starts several Windows ACL probes.
const recoveryPollMillis = process.platform === "win32" ? 22_000 : 2_000;

test.each([
  { label: "Pi not found", preflightError: "Review preflight failed (pi_unavailable).", message: "could not find Pi" },
  { label: "Pi with old Node", preflightError: piNodeTooOld, message: "Node is too old. Use a supported Node version" },
  { label: "Pi on macOS", preflightError: macPiUnavailable, message: "Select Claude Code for all active review steps on macOS" },
  { label: "stage failure", preflightError: null, message: "could not confirm the review result" },
  { label: "external recovery", preflightError: null, message: "could not confirm the review result", external: true },
])("refresh recovery: $label", ({ preflightError, message, external }) => withRoot(async (root) => {
  const stageFailure = preflightError === null;
  const directory = join(root, "local_only", "profiles", profileId);
  await mkdir(directory, { recursive: true });
  await Effect.runPromise(Effect.gen(function* () {
    const records = yield* pipelineRecords(root, join(directory, "local-pipeline-run.json"), profileId);
    const recordLayer = yield* Effect.context<Effect.Effect.Context<typeof records.read>>();
    const nextId = "b".repeat(32);
    let calls = 0;
    let stagesRun = 0;
    const ok = { returncode: 0, stdout: "", stderr: "" };

    const refresh: CheckoutRefresh["Type"]["run"] = ({ onProgress, reset, noPublish }) => Effect.gen(function* () {
      calls++;
      expect(noPublish).toBe(true);
      expect(reset).toBe(stageFailure && calls === 2);

      const result = yield* runLockedPipeline({
        profileId, reviewerId: null, reset: reset ?? false, once: false, newRunId: () => calls === 1 ? runId : nextId,
        records, onProgress,
        preflight: () => Effect.succeed(preflightError !== null && calls === 1
          ? { ...ok, returncode: 2, stderr: preflightError } : ok),
        stages: stageNames.map((name) => ({ name, timeoutMillis: 1000, run: () => Effect.sync(() => {
          stagesRun++;

          return stageFailure && calls === 1 && name === "review"
            ? { ...ok, returncode: 2, stderr: "Review outcome is unknown and was not retried." } : ok;
        }) })),
      });

      return { exitCode: result.exitCode, completionIds: result.status === "completed" ? [nextId] : [] };
    }).pipe(Effect.provide(recordLayer), Effect.orDie);

    yield* Effect.gen(function* () {
      const { status, start } = client(yield* DashboardServer);
      const resetBody = (id: string) => JSON.stringify({ confirm: true, reset_run_id: id });
      const token = (yield* status).csrf_token;
      expect((yield* start(token, resetBody(runId)))?.status).toBe(409);
      expect((yield* start(token))?.status).toBe(202);
      const failed = yield* waitForFinish(status, recoveryPollMillis);
      expect(failed).toMatchObject({
        status: "failed", reset_run_id: stageFailure ? runId : null,
        error: expect.stringContaining(message),
      });
      expect(failed.log.at(-1)).toMatchObject({ level: "error", message: failed.error });
      const saved = yield* records.read;
      expect(saved).toMatchObject({ run_id: runId, ended_at: expect.any(String) });

      if (external) {
        yield* withInstallationLock(root, () => records.write(completedRecord({ ...initial(), run_id: nextId, stage: "snapshot" })));
        expect(yield* status).toMatchObject({ status: "succeeded", reset_run_id: null, ended_at: null, error: null });
        expect((yield* start(token, resetBody(runId)))?.status).toBe(409);
        expect(calls).toBe(1);

        return;
      }

      if (stageFailure) {
        expect((yield* start(token))?.status).toBe(409);
        expect((yield* start(token, resetBody(nextId)))?.status).toBe(409);
        expect(failed.stages).toContainEqual({ stage: "review", status: "failed" });
      } else {
        expect(stagesRun).toBe(0);
      }

      expect(calls).toBe(1);
      expect((yield* start(token, stageFailure ? resetBody(runId) : undefined))?.status).toBe(202);
      expect(yield* waitForFinish(status, recoveryPollMillis)).toMatchObject({ status: "succeeded", reset_run_id: null });
      expect(yield* records.read).toMatchObject({
        run_id: nextId, previous_run_id: runId, failed_attempts: 0, status: "completed", ended_at: expect.any(String),
        reset_at: stageFailure ? expect.any(String) : null,
      });
      expect((yield* start(token, resetBody(runId)))?.status).toBe(409);
      expect(calls).toBe(2);
    }).pipe(Effect.provide(fixture(config(root), refresh)));
  }).pipe(Effect.provide(files)));
}), process.platform === "win32" ? 40_000 : undefined);

test("a reopened server reads only safe facts from the last saved pipeline record", () => withRoot(async (root) => {
  const directory = join(root, "local_only", "profiles", profileId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "local-pipeline-run.json");
  const read = () => Effect.runPromise(Effect.flatMap(DashboardServer, (server) => client(server).status).pipe(Effect.provide(fixture(config(root)))));
  await writeFile(path, JSON.stringify(completedRecord({ ...initial(), stage: "snapshot" })));
  const completed = await read();
  expect(completed).toMatchObject({ status: "succeeded", started_at: null, ended_at: null, error: null });
  expect(completed.stages.map(({ status }) => status)).toEqual(stageNames.map(() => "unknown"));
  await writeFile(path, JSON.stringify({ ...initial(), stage: "review", status: "failed", ended_at: stamp, last_outcome: "permanent review: exit 2", failure_detail: "invented private log" }));
  const failed = await read();
  expect(failed).toMatchObject({ status: "failed", reset_run_id: runId, ended_at: stamp, error: "A refresh stage failed.", log: [] });
  expect(failed.stages).toContainEqual({ stage: "review", status: "unknown" });
  expect(JSON.stringify(failed)).not.toContain("invented private log");
  const last_market_recording = { captured_at: stamp, run_id: runId };
  await writeFile(path, JSON.stringify(completedRecord({
    ...initial(), stage: "snapshot", ended_at: stamp, last_market_recording,
    stage_results: { market: "skipped", snapshot: "succeeded" },
  })));
  expect(await read()).toMatchObject({
    status: "succeeded", started_at: null, ended_at: stamp, last_market_recording,
    stages: [
      { stage: "sync-source", status: "pending" },
      { stage: "resolve-locations", status: "pending" },
      { stage: "market", status: "skipped" },
      { stage: "review", status: "pending" },
      { stage: "snapshot", status: "succeeded" },
    ],
  });
  await writeFile(path, JSON.stringify(initial()));
  expect(await read()).toMatchObject({ status: "failed", error: expect.stringContaining("no final result") });
}));

test("tracked configuration resolves relative to both source and adapter bundle", () => {
  const root = process.platform === "win32" ? "C:\\checkout" : "/checkout";

  for (const path of ["src/lib/server/filter/service.ts", "build/server/chunks/runtime.js"]) {
    expect(packageConfigPath(pathToFileURL(join(root, path)).href, "area_extents.json")).toBe(join(root, "config", "area_extents.json"));
  }
});
