import { syntheticServeHost, syntheticServeOrigin } from "../shared/serve-hosts.ts";
import { CommandExecutor, FileSystem, Terminal } from "@effect/platform";
import { Database } from "bun:sqlite";
import { ConfigProvider, Effect, Inspectable, Layer, Predicate, Scope, Sink, Stream } from "effect";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import type { CheckoutReport } from "../../src/cli/checkout-reports.ts";
import { conflictsWithFeedback } from "../../src/cli/dashboard.ts";
import { makeCheckoutCli } from "../../src/cli/pulse.ts";
import { windowsScheduleLauncher } from "../../src/cli/schedule.ts";
import { BackupError } from "../../src/cli/sqlite-backup.ts";
import { CheckoutRefresh, refresh } from "../../src/cli/pulse-refresh.ts";
import { PublishError } from "../../src/cli/pulse-publish.ts";
import { DashboardLauncher } from "../../src/lib/server/dashboard/launcher.ts";
import { runLocalPipeline } from "../../src/lib/server/orchestration/local-pipeline.ts";
import type { RunRecord } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { Schedule } from "../../src/lib/server/orchestration/schedule.ts";
import { latestScheduledRun } from "../../src/lib/server/orchestration/scheduled-runs.ts";
import { requireInstallationLease, withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";
import { ProfileFiles } from "../../src/lib/server/profile/files.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { PipelineLive } from "../../src/lib/server/runtime.ts";
import { publishSnapshot } from "../../src/lib/server/snapshot/store.ts";
import snapshot from "../../contracts/fixtures/snapshot.example.json";
import { profileServices, syntheticSplit } from "../profile/fixtures.ts";
import { examplePersonalInputs, exampleSettings } from "../snapshot/settings-fixture.ts";

const abort = () => Effect.dieMessage("Unexpected CLI operation");
const railway = () => "/invented/bin/railway";
const id = "invented";
const runId = "a".repeat(32);

const record = {
  run_id: runId, profile_id: id, reviewer_id: "judge", status: "completed", stage: "snapshot", failed_attempts: 0,
  last_outcome: "passed snapshot", next_attempt_at: null, previous_run_id: null, reset_at: null, failure_detail: null,
} satisfies RunRecord;

const complete = { status: "completed", run_id: runId, stage: "snapshot", next_attempt_at: null, exitCode: 0, warnings: [] } as const;
const settings = 'service = "invented-viewer"\nvolume = "invented-volume"\n';
const snapshotAt = (directory: string) => join(directory, "dashboard-snapshot.sqlite3");

const saveSnapshot = (directory: string, publishedAt = "2026-10-19T12:00:00+00:00") => publishSnapshot(snapshotAt(directory), {
  html: new TextEncoder().encode("invented snapshot"), publishedAt,
  shortlist: { profile_id: id, listing_ids: ["invented-job"] },
});

const fixture = Effect.gen(function* () {
  const selected = yield* syntheticSplit;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(join(selected.root, "local_only", "publish.toml"), settings);

  return { ...selected, fs };
});

const layers = Layer.merge(PipelineLive, profileServices);

const run = <A, E>(program: Effect.Effect<A, E, Layer.Layer.Success<typeof layers> | Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layers)));

const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.acquireUseRelease(Effect.sync(() => {
  const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...saved, value: "win32" });

  return saved;
}), () => effect, (saved) => Effect.sync(() => { Object.defineProperty(process, "platform", saved); }));

const legacyTarget = ["volume", "--service", "invented-viewer", "files", "--volume", "invented-volume"];

const makeUpload = (root: string, targetArgs = legacyTarget) => {
  const copies: string[] = [];

  const executor = CommandExecutor.makeExecutor((command) => Effect.sync(() => {
    if (!Predicate.isTagged(command, "StandardCommand")) throw new Error("Unexpected pipe");
    const path = command.args.at(-2) ?? "";
    expect(command.command).toBe(railway());
    expect(command.cwd).toMatchObject({ value: root });
    expect(command.stdin).toBe("pipe");
    expect(command.args).toEqual([...targetArgs, "upload", "--overwrite", path, "/digests.sqlite"]);
    expect(path).not.toContain(root);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new Database(path, { readonly: true });

    try { expect(db.query("SELECT count(*) AS n FROM digest_snapshots").get()).toEqual({ n: 1 }); }
    finally { db.close(); }

    copies.push(path);

    return {
      [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId, pid: CommandExecutor.ProcessId(123),
      exitCode: Effect.succeed(CommandExecutor.ExitCode(0)), isRunning: Effect.succeed(false), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.empty, stderr: Stream.empty,
      toJSON: () => ({}), toString: () => "Fake upload", [Inspectable.NodeInspectSymbol]: () => ({}),
    };
  }));

  return { copies, executor };
};

const harness = (root: string, targetArgs?: string[]) => {
  const upload = makeUpload(root, targetArgs);
  const start = vi.fn<DashboardLauncher["Type"]["start"]>(() => Effect.succeed(0));

  const install = vi.fn<Schedule["Type"]["install"]>((input) => Effect.gen(function* () {
    if (!(yield* input.available) || !(yield* input.ready)) return false;

    return (yield* input.io.ask("Install?")) === "yes";
  }));

  const which = vi.fn<(name: string, searchPath?: string) => string | null>((name) => name === "railway" ? railway() : null);
  const timerStatus = vi.fn<Schedule["Type"]["status"]>(() => Effect.succeed({ installed: false, partial: false }));
  const remove = vi.fn<Schedule["Type"]["remove"]>(() => Effect.succeed(true));
  const runNow = vi.fn<Schedule["Type"]["runNow"]>(() => Effect.succeed(true));
  const scheduledRefresh = vi.fn<CheckoutRefresh["Type"]["run"]>(abort);
  const rereview = vi.fn<NonNullable<CheckoutRefresh["Type"]["rereview"]>>(() => Effect.succeed(0));
  const readLine = vi.fn(() => "no");

  const ask = Terminal.Terminal.of({
    columns: Effect.succeed(80), rows: Effect.succeed(24), display: () => Effect.void, readInput: abort(),
    isTTY: Effect.succeed(true), readLine: Effect.sync(readLine),
  });

  const dispatch = (...args: string[]) => Effect.gen(function* () {
    let report: CheckoutReport | undefined;
    const cli = makeCheckoutCli({ defaultRoot: root, which }, (output) => Effect.sync(() => { report = output; }), abort);

    yield* cli(["bun", "pulse.ts", ...args]).pipe(
      Effect.provideService(DashboardLauncher, { start }),
      Effect.provideService(CommandExecutor.CommandExecutor, upload.executor),
      Effect.provideService(Terminal.Terminal, ask),
      Effect.provideService(CheckoutRefresh, { run: scheduledRefresh, rereview }),
      Effect.provideService(Schedule, { install, remove, status: timerStatus, runNow }),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["XDG_CONFIG_HOME", join(root, "config")], ["PATH", "/invented/bin"]]))),
    );

    return report;
  });

  return { dispatch, start, install, scheduledRefresh, rereview, readLine, which, timerStatus, remove, runNow, ...upload };
};

test("public commands reject removed verbs and malformed flags without running work", () => run(Effect.gen(function* () {
  const { root } = yield* fixture;
  const { dispatch, start, install, scheduledRefresh, copies } = harness(root);
  const help = yield* dispatch("--help");
  expect(help?.stdout?.match(/  - [\w-]+/gu)).toEqual([
    "  - doctor", "  - status", "  - dashboard", "  - desktop", "  - desktop", "  - desktop", "  - refresh", "  - publish", "  - schedule", "  - schedule", "  - schedule",
    "  - schedule", "  - schedule", "  - run-scheduled", "  - demo", "  - sqlite_backup", "  - re-review", "  - init",
  ]);

  for (const args of [
    ["doctor", "--unsupported"], ["profile", "check"], ["snapshot", "export"], ["feedback", "export"], ["schedule", "show"],
    ["refresh", "--dry-run"], ["refresh", "--no-publish=false"], ["refresh", "--NO-PUBLISH"],
    ["desktop", "--port", "8770"], ["desktop", "--read-only=false"], ["desktop", "--snapshot"],
    ["publish", "--apply", "--wizard"], ["publish", "--help", "--apply"], ["schedule", "install", "--", "--profile", id],
  ]) expect(yield* dispatch(...args)).toMatchObject({ exitStatus: 2, stdout: "" });
  expect(start).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  expect(scheduledRefresh).not.toHaveBeenCalled();
  expect(copies).toEqual([]);
})));

test("re-review dispatches only the explicit local selection", () => run(Effect.gen(function* () {
  const { root } = yield* fixture;
  const { dispatch, rereview, scheduledRefresh, copies } = harness(root);
  const listing = "00000000-0000-0000-0000-000000000001";

  for (const args of [[], ["--all", "--listings", listing], ["--all", "--apply"]]) {
    expect((yield* dispatch("--profile", id, "re-review", ...args))?.exitStatus).toBe(2);
  }

  expect(rereview).not.toHaveBeenCalled();
  expect((yield* dispatch("--profile", id, "re-review", "--listings", listing))?.exitStatus).toBe(0);
  expect(rereview).toHaveBeenLastCalledWith(root, id, [listing]);
  expect((yield* dispatch("--profile", id, "re-review", "--all"))?.exitStatus).toBe(0);
  expect(rereview).toHaveBeenLastCalledWith(root, id, true);
  expect(scheduledRefresh).not.toHaveBeenCalled();
  expect(copies).toEqual([]);
})));

test("publish needs apply and consent and uploads only a private newest-row copy", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const { dispatch, readLine, copies } = harness(root);
  yield* saveSnapshot(directory);
  yield* saveSnapshot(directory, "2026-10-20T12:00:00+00:00");
  const before = yield* fs.readFile(snapshotAt(directory));
  expect((yield* dispatch("--profile", id, "publish", "--yes"))?.exitStatus).toBe(0);
  expect(readLine).not.toHaveBeenCalled();
  expect((yield* dispatch("--profile", id, "publish", "--apply"))?.exitStatus).toBe(2);
  expect(copies).toEqual([]);
  readLine.mockReturnValue("y");
  expect((yield* dispatch("--profile", id, "publish", "--apply"))?.exitStatus).toBe(0);
  expect(copies).toHaveLength(1);
  expect(yield* fs.exists(copies[0]!)).toBe(false);
  expect(yield* fs.readFile(snapshotAt(directory))).toEqual(before);
})));

test("CLI forwards both live acceptance guard flags", () => run(Effect.gen(function* () {
  const { root } = yield* fixture;
  const { dispatch, scheduledRefresh } = harness(root);
  scheduledRefresh.mockReturnValue(Effect.succeed({ exitCode: 0, completionIds: [runId] }));

  expect((yield* dispatch("--profile", id, "refresh", "--no-publish", "--no-notify"))?.exitStatus).toBe(0);
  expect(scheduledRefresh).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ noPublish: true, noNotify: true, reset: false }));
})));

test("refresh checks the persisted completion and keeps the installation lease for upload", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const { copies, executor } = makeUpload(root);
  const statusPath = join(directory, "local-pipeline-run.json");

  const pipeline = vi.fn<typeof import("../../src/lib/server/orchestration/local-pipeline.ts").runLocalPipeline>((options) => Effect.gen(function* () {
    expect(options.installationLease).toBeDefined();
    yield* requireInstallationLease(root, options.installationLease!).pipe(Effect.orDie);

    return complete;
  }));

  const cache = join(directory, "hosted-feedback.json");
  const saved = JSON.stringify({ schema: "pulse.feedback_events", schema_version: 1, profile_id: id, events: [] });

  yield* fs.writeFileString(join(root, "local_only", "publish.toml"), settings + 'public_url = "https://invented.invalid"\n');
  yield* fs.writeFileString(join(root, "local_only", "feedback-token"), "a".repeat(43), { mode: 0o600 });

  const invoke = (noPublish = false) => refresh({ root, id, railway, noPublish }, pipeline)
    .pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor));

  expect((yield* invoke()).exitCode).toBe(1);
  expect(copies).toEqual([]);
  yield* fs.writeFileString(statusPath, JSON.stringify(record));
  yield* saveSnapshot(directory);
  expect(yield* invoke(true)).toEqual({ exitCode: 0, completionIds: [runId] });
  expect(copies).toEqual([]);

  expect(yield* fs.exists(cache)).toBe(false);
  yield* fs.writeFileString(cache, saved, { mode: 0o600 });
  expect(yield* invoke()).toEqual({ exitCode: 0, completionIds: [runId] });
  expect(yield* fs.readFileString(cache)).toBe(saved);

  expect(copies).toHaveLength(1);
  expect(yield* fs.exists(copies[0]!)).toBe(false);
})));

test("manual and scheduled refresh keep the snapshot local without a publish file or Railway", () => run(Effect.gen(function* () {
  const { root, directory } = yield* syntheticSplit;
  const fs = yield* FileSystem.FileSystem;
  const lookup = vi.fn(() => null);
  const pipeline = vi.fn(() => Effect.succeed(complete));
  const { executor, copies } = makeUpload(root);
  yield* fs.writeFileString(join(directory, "local-pipeline-run.json"), JSON.stringify(record));

  for (const options of [{}, { scheduled: true }, { volume: "invented-volume" }]) {
    expect(yield* refresh({ root, id, railway: lookup, ...options }, pipeline).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
    )).toEqual({ exitCode: 0, completionIds: [runId] });
  }

  expect(pipeline).toHaveBeenCalledTimes(3);
  expect(lookup).not.toHaveBeenCalled();
  expect(copies).toEqual([]);
})));

test("only an opted-in upload checks for Railway, and --no-publish bypasses invalid settings", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const path = join(root, "local_only", "publish.toml");
  const lookup = vi.fn(() => null);
  const pipeline = vi.fn(() => Effect.succeed(complete));

  const invoke = (options: { readonly scheduled?: boolean; readonly noPublish?: boolean }) =>
    refresh({ root, id, railway: lookup, ...options }, pipeline);

  for (const scheduled of [false, true]) {
    expect(yield* invoke({ scheduled })).toEqual({ exitCode: 2, completionIds: [], failedStage: "preflight" });
  }

  expect(pipeline).not.toHaveBeenCalled();
  expect(lookup).toHaveBeenCalledTimes(2);
  lookup.mockClear();
  yield* fs.writeFileString(path, "invalid [");
  expect(yield* invoke({})).toEqual({ exitCode: 2, completionIds: [], failedStage: "preflight" });
  expect(pipeline).not.toHaveBeenCalled();
  yield* fs.writeFileString(join(directory, "local-pipeline-run.json"), JSON.stringify(record));
  expect(yield* invoke({ noPublish: true })).toEqual({ exitCode: 0, completionIds: [runId] });
  yield* fs.writeFileString(path, 'service = "invented-viewer"\n');
  expect(yield* invoke({ scheduled: true })).toEqual({ exitCode: 0, completionIds: [runId] });
  expect(lookup).not.toHaveBeenCalled();
})));

test("guarded refresh skips ntfy preparation and upload; unsafe flag combinations do not run", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const files = yield* ProfileFiles;
  const check = vi.fn(files.check);
  const lookup = vi.fn(railway);
  const pipeline = vi.fn(() => Effect.succeed(complete));

  yield* fs.writeFileString(join(directory, "local-pipeline-run.json"), JSON.stringify(record));

  const invoke = (options: Pick<import("../../src/cli/pulse-refresh.ts").RefreshOptions, "noPublish" | "noNotify" | "scheduled" | "reset">) =>
    refresh({ root, id, railway: lookup, ...options }, pipeline).pipe(Effect.provideService(ProfileFiles, { ...files, check }));

  for (const options of [{}, { noPublish: true, reset: true }, { noPublish: true, scheduled: true }]) {
    expect((yield* invoke({ noNotify: true, ...options })).exitCode).toBe(2);
  }

  expect(pipeline).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  const checksNtfy = () => check.mock.calls.some(([, path]) => path.endsWith("ntfy.toml"));
  expect(yield* invoke({ noNotify: true, noPublish: true })).toEqual({ exitCode: 0, completionIds: [runId] });
  expect(checksNtfy()).toBe(false);
  expect(lookup).not.toHaveBeenCalled();
  expect((yield* invoke({ noPublish: true })).exitCode).toBe(0);
  expect(checksNtfy()).toBe(true);
})));

test("refresh reports that a stopped run needs reset without upload", () => run(Effect.gen(function* () {
  const { root } = yield* fixture;

  const stopped = yield* refresh({ root, id, railway, noPublish: true }, () => Effect.succeed({
    ...complete, status: "previous_stopped", exitCode: 2,
  }));

  expect(stopped).toEqual({ exitCode: 2, completionIds: [], failedStage: "pipeline", requiresReset: true });
})));

test.each([4, 5])("v%s private inputs require profile opt-in and all four destination IDs", (version) => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const [project, environment, service, volume] = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);

  const { dispatch, copies, executor } = harness(root, [
    "volume", "--project", project!, "--environment", environment!, "--service", service!, "files", "--volume", volume!,
  ]);

  const dashboardJson = new TextEncoder().encode(JSON.stringify({
    ...snapshot, profile: { ...snapshot.profile, id }, schema_version: version,
    settings: exampleSettings, personal_inputs: examplePersonalInputs,
    run_funnel: version === 5 ? { nav_events: 0, pool: null } : undefined,
  }));

  yield* publishSnapshot(snapshotAt(directory), {
    html: new Uint8Array(), dashboardJson, shortlist: { profile_id: id, listing_ids: [] },
  });

  yield* fs.writeFileString(join(directory, "local-pipeline-run.json"), JSON.stringify(record));
  const configPath = join(root, "local_only", "publish.toml");
  const base = settings + 'public_url = "https://invented.invalid"\n';

  const invoke = (scheduled: boolean, volumeOverride?: string) => refresh({ root, id, railway, scheduled, volume: volumeOverride }, () => Effect.succeed(complete))
    .pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor));

  const optIn = 'profile = "invented"\nallow_private_inputs = true\n';
  const destinationFields = [`project = "${project}"\n`, `environment = "${environment}"\n`, `service = "${service}"\n`, `volume = "${volume}"\n`];
  const origin = 'public_url = "https://invented.invalid"\n';
  const approved = optIn + destinationFields.join("") + origin;

  for (const config of [base, base + 'allow_private_inputs = false\n', base + 'allow_private_inputs = true\n',
    base + 'profile = "other"\nallow_private_inputs = true\n', base + 'profile = "invented"\nallow_private_inputs = "true"\n', base + optIn,
    ...destinationFields.map((_, missing) => optIn + destinationFields.filter((_, index) => index !== missing).join("") + origin)]) {
    yield* fs.writeFileString(configPath, config);
    const denied = yield* Effect.flip(dispatch("--profile", id, "publish", "--apply", "--yes"));

    expect(denied).toBeInstanceOf(PublishError);
    expect(denied).toMatchObject({ message: expect.stringMatching(/^(Upload blocked|Cannot use local_only)/u) });

    for (const scheduled of [false, true]) {
      const outcome = yield* invoke(scheduled);

      if (scheduled && !config.includes("volume =")) expect(outcome).toEqual({ exitCode: 0, completionIds: [runId] });
      else expect(outcome).toMatchObject({ failedStage: expect.stringMatching(/^(snapshot-export|preflight)$/u) });
    }
  }

  expect(copies).toEqual([]);

  yield* fs.writeFileString(configPath, approved);

  for (const flag of ["--service", "--volume"]) {
    expect(yield* Effect.flip(dispatch("--profile", id, "publish", "--apply", "--yes", flag, project!))).toBeInstanceOf(PublishError);
  }

  expect(yield* invoke(false, project)).toMatchObject({ exitCode: 1, failedStage: "snapshot-export" });
  expect(copies).toEqual([]);
  expect((yield* dispatch("--profile", id, "publish", "--apply", "--yes", "--volume", volume!))?.exitStatus).toBe(0);
  expect(yield* invoke(true)).toEqual({ exitCode: 0, completionIds: [runId] });
  expect(copies).toHaveLength(2);

  yield* publishSnapshot(snapshotAt(directory), {
    html: new Uint8Array(),
    dashboardJson: new TextEncoder().encode(JSON.stringify({
      ...snapshot, profile: { ...snapshot.profile, id: "other" }, schema_version: version,
      settings: exampleSettings, personal_inputs: examplePersonalInputs,
      run_funnel: version === 5 ? { nav_events: 0, pool: null } : undefined,
    })),
    shortlist: { profile_id: id, listing_ids: [] },
  });

  const mismatch = yield* Effect.flip(dispatch("--profile", id, "publish", "--apply", "--yes"));

  expect(mismatch).toMatchObject({ message: "Upload blocked: the snapshot belongs to another profile." });
  expect(yield* invoke(false)).toMatchObject({ exitCode: 1, failedStage: "snapshot-export" });
  expect(yield* invoke(true)).toMatchObject({ exitCode: 1, failedStage: "snapshot-export" });
  expect(copies).toHaveLength(2);
})));

test("v1 through v3 retain legacy overrides and linked project selection", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const { dispatch, copies } = harness(root, ["volume", "--service", "override-viewer", "files", "--volume", "override-volume"]);
  yield* fs.writeFileString(join(root, "local_only", "publish.toml"), settings
    + 'profile = "invented"\nallow_private_inputs = true\nproject = "00000000-0000-4000-8000-000000000001"\n');
  const v1 = { ...snapshot, profile: { ...snapshot.profile, id } };

  for (const document of [v1, { ...v1, schema_version: 2, market_history: null }, { ...v1, schema_version: 3, settings: exampleSettings }]) {
    yield* publishSnapshot(snapshotAt(directory), {
      html: new Uint8Array(), dashboardJson: new TextEncoder().encode(JSON.stringify(document)), shortlist: { profile_id: id, listing_ids: [] },
    });
    expect((yield* dispatch("--profile", id, "publish", "--apply", "--yes", "--service", "override-viewer", "--volume", "override-volume"))?.exitStatus).toBe(0);
  }

  expect(copies).toHaveLength(3);
})));

test("Windows task launcher mode does not depend on a resource override", () => {
  const bun = "C:\\tools\\bun.exe";
  const installed = "C:\\Program Files\\Pulse\\resources\\pulse.exe";
  const entry = "C:\\checkout\\src\\cli\\pulse.ts";
  const checkoutEntry = vi.fn(() => entry);

  vi.stubEnv("PULSE_RESOURCE_ROOT", "C:\\custom\\resources");

  try {
    expect(windowsScheduleLauncher(true, installed, checkoutEntry)).toEqual([installed]);
    expect(checkoutEntry).not.toHaveBeenCalled();
    expect(windowsScheduleLauncher(false, bun, checkoutEntry)).toEqual([bun, "--no-env-file", entry]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test.skipIf(process.platform === "win32")("schedule install supplies the selected Linux checkout command and leaves the decision to the timer prompt", () => run(Effect.gen(function* () {
  const { root, profileFile, config } = yield* syntheticSplit;
  const fs = yield* FileSystem.FileSystem;
  const { dispatch, install, readLine, which, timerStatus, remove, runNow } = harness(root);
  which.mockReturnValue(null);
  const command = [process.execPath, expect.stringMatching(/src[/\\]cli[/\\]pulse\.ts$/u), "--root", root, "--profile", id, "run-scheduled"];
  const target = { root, profileId: id, unitDir: join(root, "config", "systemd", "user") };
  const searchPath = resolve("/invented/bin");
  const models = yield* fs.readFileString("tests/fixtures/port-oracle/basic-run/inputs/models.toml");
  yield* fs.writeFileString(join(root, "local_only", "models.toml"), models);
  yield* fs.writeFileString(profileFile, config + '\n[schedule]\nschedule = "weekly fri 09:00"\n');
  expect(yield* Effect.flip(dispatch("--root", root, "--profile", id, "schedule", "install"))).toMatchObject({ message: "Timer installation was not completed." });
  expect(install.mock.calls[0]?.[0]).toMatchObject({
    ...target, searchPath, command,
  });
  expect(which).toHaveBeenCalledWith("pi", searchPath);
  expect(readLine).not.toHaveBeenCalled();
  which.mockImplementation((name) => name === "railway" ? null : `/invented/bin/${name}`);
  readLine.mockReturnValue("yes");
  yield* dispatch("--root", root, "--profile", id, "schedule", "install");
  expect(install).toHaveBeenCalledTimes(2);
  expect(readLine).toHaveBeenCalledTimes(1);
  expect(which).not.toHaveBeenCalledWith("railway", searchPath);
  yield* fs.writeFileString(join(root, "local_only", "publish.toml"), settings);
  expect(yield* Effect.flip(dispatch("--root", root, "--profile", id, "schedule", "install"))).toMatchObject({ message: "Timer installation was not completed." });
  expect(which).toHaveBeenCalledWith("railway", searchPath);
  expect(readLine).toHaveBeenCalledTimes(1);
  which.mockImplementation((name) => `/invented/bin/${name}`);
  yield* dispatch("--root", root, "--profile", id, "schedule", "install");
  expect(install).toHaveBeenCalledTimes(4);
  expect(readLine).toHaveBeenCalledTimes(2);
  yield* dispatch("--root", root, "--profile", id, "schedule", "status");
  expect(timerStatus).toHaveBeenCalledWith(target);
  yield* dispatch("--root", root, "--profile", id, "schedule", "remove");
  expect(remove).toHaveBeenCalledWith(expect.objectContaining({ root, profileId: id }));
  yield* dispatch("--root", root, "--profile", id, "schedule", "run-now");
  expect(runNow).toHaveBeenCalledWith(expect.objectContaining(target));
})));

test.skipIf(process.platform === "win32")("scheduled CLI calls refresh with a live lease and records its completion", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const { dispatch, scheduledRefresh } = harness(root);
  scheduledRefresh.mockImplementation(({ root, lease, scheduled }) => Effect.gen(function* () {
    expect(scheduled).toBe(true);
    yield* requireInstallationLease(root, lease!).pipe(Effect.orDie);
    yield* fs.writeFileString(join(directory, "local-pipeline-run.json"), JSON.stringify(record)).pipe(Effect.orDie);

    return { exitCode: 0, completionIds: [runId] };
  }));
  expect((yield* dispatch("--root", root, "--profile", id, "run-scheduled"))?.exitStatus).toBe(0);
  expect(scheduledRefresh).toHaveBeenCalledTimes(1);
  expect(yield* latestScheduledRun(root, id)).toMatchObject({ status: "ok", failed_stage: null });
})));

test("Windows schedule commands reach the selected adapter and an out-of-period run skips refresh", () => run(Effect.gen(function* () {
  const { config } = yield* fixture;
  const root = "C:\\invented\\pulse";
  const { dispatch, install, remove, runNow, timerStatus, scheduledRefresh } = harness(root);
  const files = yield* ProfileFiles;
  const profiles = yield* Profile;
  const checkedRoot = vi.fn(() => Effect.succeed(root));
  const selectors = ["--root", root, "--profile", id];
  const target = { root, profileId: id, command: [process.execPath, "--no-env-file", expect.stringMatching(/src[/\\]cli[/\\]pulse\.ts$/u), ...selectors, "run-scheduled"] };
  install.mockReturnValue(Effect.succeed(true));

  yield* onWindows(Effect.gen(function* () {
    for (const verb of ["install", "run-now", "status", "remove"]) yield* dispatch(...selectors, "schedule", verb);
    expect(install).toHaveBeenCalledWith(expect.objectContaining(target));
    expect(runNow).toHaveBeenCalledWith(expect.objectContaining(target));
    expect(timerStatus).toHaveBeenCalledWith(target);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining(target));
    checkedRoot.mockClear();
    expect(yield* dispatch(...selectors, "run-scheduled", "--only-if-due", "--period", "every 2 days", "--anchor", "2099-01-01")).toMatchObject({ exitStatus: 0 });
    expect(checkedRoot).toHaveBeenCalledWith(root);
    expect(scheduledRefresh).not.toHaveBeenCalled();
  }).pipe(
    Effect.provideService(ProfileFiles, { ...files, root: checkedRoot, read: () => Effect.succeed(config + '\n[schedule]\nschedule = "weekly fri 09:00"\n') }),
    Effect.provideService(Profile, { ...profiles, cadence: () => Effect.succeed({ kind: "weekly", anchor: null }) }),
  ));
})));

test.skipIf(process.platform === "win32")("Windows manual refresh calls the injected pipeline and keeps its failure stage", () => run(Effect.gen(function* () {
  const { root } = yield* fixture;
  const files = yield* ProfileFiles;
  const pipeline = vi.fn<typeof runLocalPipeline>(() => Effect.succeed({ ...complete, status: "failed", stage: "review", exitCode: 2 }));
  const lookup = vi.fn(() => { throw new Error("Unexpected Railway lookup"); });

  yield* withInstallationLock(root, (lease) => onWindows(Effect.gen(function* () {
    expect(yield* refresh({ root, id, lease, noPublish: true, railway: lookup }, pipeline)).toEqual({ exitCode: 2, completionIds: [], failedStage: "review" });
    expect(pipeline).toHaveBeenCalledWith(expect.objectContaining({ root, profileId: id, installationLease: lease }));
    expect(lookup).not.toHaveBeenCalled();
  }).pipe(Effect.provideService(ProfileFiles, { ...files, root: () => Effect.succeed(root) }))));
})));

test("Windows feedback comparisons include case aliases and descendants of every SQLite path", () => {
  const feedback = "C:\\Pulse\\shortlist-feedback.sqlite3";
  const alias = "c:\\PULSE\\Shortlist-Feedback.sqlite3";

  for (const suffix of ["", "-WAL", "-SHM", "-JOURNAL"]) {
    expect(conflictsWithFeedback("win32", feedback, [alias + suffix])).toBe(true);
    expect(conflictsWithFeedback("win32", feedback, [alias + suffix + "\\child"])).toBe(true);
    expect(conflictsWithFeedback("win32", feedback, [alias + suffix + ".bak"])).toBe(false);
  }

  expect(conflictsWithFeedback("win32", feedback, ["D:\\Pulse\\shortlist-feedback.sqlite3"])).toBe(false);
  expect(conflictsWithFeedback("linux", "/Pulse/shortlist-feedback.sqlite3", ["/Pulse/Shortlist-Feedback.sqlite3"])).toBe(false);
});

test("only the writable selected dashboard opens before the first snapshot", () => run(Effect.gen(function* () {
  const { root, directory, fs } = yield* fixture;
  const { dispatch, start } = harness(root);
  const saved = join(directory, "dashboard-snapshot.json");
  expect((yield* dispatch("--profile", id, "dashboard"))?.exitStatus).toBe(0);
  expect(start).toHaveBeenCalledExactlyOnceWith({
    port: 8770, snapshot: saved, feedback: { directory, profileId: id }, localSettings: { root, profileId: id },
  });
  expect(yield* fs.exists(saved)).toBe(false);
  expect((yield* dispatch("--profile", id, "dashboard", "--read-only"))?.exitStatus).toBe(1);
  yield* fs.writeFileString(saved, "not a snapshot");
  expect((yield* dispatch("--profile", id, "dashboard"))?.exitStatus).toBe(1);
  expect(start).toHaveBeenCalledTimes(1);
})));

test("dashboard binds writes to its selected profile; read-only and explicit snapshots do not opt in",  () => run(Effect.gen(function* () {
  const { root, directory, fs, profileFile, config } = yield* fixture;
  const { dispatch, start } = harness(root);
  const saved = join(directory, "dashboard-snapshot.json");
  yield* fs.writeFileString(saved, JSON.stringify({ ...snapshot, profile: { ...snapshot.profile, id } }));
  expect((yield* dispatch("--profile", id, "dashboard"))?.exitStatus).toBe(0);
  expect(start).toHaveBeenLastCalledWith({
    port: 8770, snapshot: saved, feedback: { directory, profileId: id }, localSettings: { root, profileId: id },
  });
  expect((yield* dispatch("--profile", id, "dashboard", "--read-only"))?.exitStatus).toBe(0);
  expect(start).toHaveBeenLastCalledWith({ port: 8770, snapshot: saved });
  const origin = syntheticServeOrigin;
  const owner = "owner@invented.test";
  const serve = ["--serve-origin", origin, "--serve-owner", owner];

  for (const flags of [serve.slice(0, 2), [...serve, "--read-only"], [...serve, "--snapshot", saved]]) {
    expect((yield* dispatch("--profile", id, "dashboard", ...flags))?.exitStatus).toBe(1);
  }

  expect((yield* dispatch("--profile", id, "dashboard", ...serve))?.exitStatus).toBe(0);
  expect(start).toHaveBeenLastCalledWith({
    port: 8770, snapshot: saved, feedback: { directory, profileId: id }, localSettings: { root, profileId: id },
    serve: { origin, host: syntheticServeHost, owner },
  });
  yield* fs.writeFileString(profileFile, config.replace(/^review_db = .+$/m, 'review_db = "shortlist-feedback.sqlite3-journal/child"'));
  expect((yield* dispatch("--profile", id, "dashboard"))?.stderr).toContain("Feedback path conflicts");
  expect((yield* dispatch("--root", join(root, "absent"), "dashboard", "--snapshot", saved))?.exitStatus).toBe(0);
  expect(start).toHaveBeenLastCalledWith({ port: 8770, snapshot: saved });
  yield* fs.writeFileString(saved, JSON.stringify({ ...snapshot, profile: { ...snapshot.profile, id: "another" } }));
  expect((yield* dispatch("--profile", id, "dashboard", "--read-only"))?.stderr).toContain("another profile");
  expect((yield* dispatch("dashboard", "--snapshot", join(root, "missing.json")))?.exitStatus).toBe(1);
  yield* fs.writeFileString(saved, "not a snapshot");
  expect((yield* dispatch("dashboard", "--snapshot", saved))?.exitStatus).toBe(1);
  expect(start).toHaveBeenCalledTimes(4);
})));

test("backup keeps saved job metadata, omits cached ad text, and does not overwrite", () => run(Effect.gen(function* () {
  const { root, fs } = yield* fixture;
  const { dispatch } = harness(root);
  const db = join(root, "input.sqlite");
  const output = join(root, "backup.sqlite");
  const source = new Database(db);
  source.exec("CREATE TABLE listings (id TEXT); INSERT INTO listings VALUES ('invented-job'); CREATE TABLE ad_texts (body TEXT); INSERT INTO ad_texts VALUES ('invented cached ad text');");
  source.close();
  const before = yield* fs.readFile(db);
  yield* dispatch("sqlite_backup", "--db", db, "--output", output);
  const backup = new Database(output, { readonly: true });

  try {
    expect(backup.query("SELECT id FROM listings").get()).toEqual({ id: "invented-job" });
    expect(backup.query("SELECT count(*) AS n FROM ad_texts").get()).toEqual({ n: 0 });
  } finally { backup.close(); }

  expect(statSync(output).mode & 0o777).toBe(0o600);
  const saved = yield* fs.readFile(output);
  expect(yield* Effect.flip(dispatch("sqlite_backup", "--db", db, "--output", output))).toBeInstanceOf(BackupError);
  expect(yield* fs.readFile(output)).toEqual(saved);
  expect(yield* fs.readFile(db)).toEqual(before);
})));
