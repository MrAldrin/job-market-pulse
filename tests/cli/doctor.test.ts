import { FileSystem } from "@effect/platform";
import { Effect, Either, JSONSchema } from "effect";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import schema from "../../contracts/doctor.schema.json";
import example from "../../contracts/fixtures/doctor.example.json";
import type { CheckoutReport } from "../../src/cli/checkout-reports.ts";
import { probeDataDirectory, type DoctorHost } from "../../src/cli/doctor-host.ts";
import { CheckoutRefresh } from "../../src/cli/pulse-refresh.ts";
import { makeCheckoutCli } from "../../src/cli/pulse.ts";
import { DoctorReport } from "../../src/lib/contracts/doctor.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { DashboardLauncher } from "../../src/lib/server/dashboard/launcher.ts";
import { ProfileFiles } from "../../src/lib/server/profile/files.ts";
import { PipelineLive } from "../../src/lib/server/runtime.ts";
import { run, syntheticSplit } from "../profile/fixtures.ts";

const models = readFileSync(new URL("../fixtures/port-oracle/basic-run/inputs/models.toml", import.meta.url), "utf8");
const privateMarker = "invented-not-for-output";
const decode = decodeStrict(DoctorReport);

const cli = (root: string, platform: NodeJS.Platform, options: Partial<DoctorHost> = {}, launcherInstalled = false) => {
  const commands: string[][] = [];
  const writes: string[] = [];
  const which = (name: string) => name === "pi" ? null : `${privateMarker}/${name}`;

  const doctor: DoctorHost = {
    platform, bunVersion: "1.4.4", checkoutNode: Effect.succeed("22.17.0"), uid: 501, which,
    commandOk: (exe, args) => Effect.sync(() => { commands.push([exe, ...args]);

 return true; }),
    canWrite: (_root, directory) => Effect.sync(() => { writes.push(directory);

 return true; }),
    dashboardBuild: Effect.succeed(null), hasNtfyTopic: () => Effect.succeed(false), ...options,
  };

  const invoke = (...args: string[]) => Effect.gen(function* () {
    let output: CheckoutReport = { stdout: "", stderr: "", exitStatus: -1 };
    const desktopLauncher = { installed: Effect.succeed(launcherInstalled), change: () => Effect.dieMessage("Unexpected launcher change") };
    const dispatch = makeCheckoutCli({ defaultRoot: root, which, doctor, desktopLauncher }, (report) => Effect.sync(() => { output = report; }));
    yield* dispatch(["bun", "pulse.ts", ...args]);

    return output;
  }).pipe(
    Effect.provideService(CheckoutRefresh, { run: () => Effect.dieMessage("Unexpected refresh") }),
    Effect.provideService(DashboardLauncher, { start: () => Effect.dieMessage("Unexpected dashboard launch") }),
    Effect.provide(PipelineLive),
  );

  return { invoke, commands, writes };
};

const checksOf = ({ stdout }: CheckoutReport) => {
  const { checks } = Either.getOrThrow(decode(JSON.parse(stdout)));

  return Object.fromEntries(checks.map(({ id, ...check }) => [id, check]));
};

const schedulers = [
  ["linux", "systemctl", "--user", "show", "--property=Version"],
  ["darwin", "launchctl", "print", "gui/501"],
  ["win32", "schtasks.exe", "/Query"],
] as const;

test.each(schedulers)("doctor uses only the read-only %s scheduler query and accepts absent optional ntfy", (platform, tool, ...args) => run(Effect.gen(function* () {
  const { root, directory } = yield* syntheticSplit;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(join(root, "local_only", "models.toml"), models);
  yield* fs.writeFileString(join(root, "local_only", "pulse.toml"), 'profile = "invented"\n');
  // Doctor is useful before the first Source refresh.
  yield* fs.remove(join(root, "data", "source.sqlite3"));
  const { invoke, commands, writes } = cli(root, platform);
  const report = yield* invoke("doctor", "--json");
  expect(report).toMatchObject({ stderr: "", exitStatus: 0 });
  expect(JSON.parse(report.stdout)).toMatchObject({ platform });
  expect(report.stdout).not.toContain(privateMarker);
  expect(report.stdout).not.toContain(root);
  expect(commands).toEqual([[`${privateMarker}/${tool}`, ...args]]);
  expect(writes).toEqual([join(root, "data"), directory, join(directory, "outbox")]);
  const checks = checksOf(report);

  if (platform === "linux") {
    expect(checks.desktop_launcher).toEqual({ ok: false, required: false, message: "Desktop launcher not installed or outdated.", fix: "Run pulse desktop install-launcher from a shell where the configured harnesses work." });
    expect((yield* invoke("doctor")).stdout).toContain("Desktop launcher not installed");
    const installed = yield* cli(root, platform, {}, true).invoke("doctor", "--json");
    expect(checksOf(installed).desktop_launcher).toMatchObject({ ok: true, required: false, fix: null });
  } else expect(checks).not.toHaveProperty("desktop_launcher");
  expect(checks).toMatchObject({
    bun: { ok: true }, node: { ok: true, required: true }, scheduler: { ok: true }, ai_harness: { ok: true }, profile_selected: { ok: true },
    data_source: { ok: true }, ntfy_topic: { ok: false, required: false },
  });
})));

test.each(schedulers.map(([platform]) => platform))("doctor shows fixes for unavailable %s scheduler and other missing requirements", (platform) => run(Effect.gen(function* () {
  const { root, directory } = yield* syntheticSplit;

  const { invoke } = cli(root, platform, {
    bunVersion: "1.0.0", checkoutNode: Effect.succeed("22.16.9"), which: (name) => ["git", "pi", "claude", "claude.exe"].includes(name) ? null : name,
    commandOk: () => Effect.succeed(false), canWrite: (_root, target) => Effect.succeed(target !== directory),
    hasNtfyTopic: () => Effect.succeed(true),
  });

  const report = yield* invoke("--root", root, "--profile", "invented", "doctor", "--json");
  expect(report).toMatchObject({ stderr: "", exitStatus: 1 });
  const checks = checksOf(report);

  for (const id of ["bun", "node", "git", "ai_harness", "reviewer", "data_profile", "data_review", "data_ledger", "scheduler"]) {
    expect(checks[id]).toMatchObject({ ok: false, required: true, fix: expect.any(String) });
  }

  expect(checks.ntfy_topic).toEqual({ ok: true, required: false, message: "An ntfy topic is set.", fix: null });
  expect(report.stdout).not.toContain(directory);
})));

test("Doctor reports missing checkout Node.js with a fix and skips the check in packages", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const missing = yield* cli(root, "linux", { checkoutNode: Effect.succeed(null) }).invoke("doctor", "--json");
  expect(checksOf(missing).node).toMatchObject({
    required: true, ok: false, fix: expect.stringContaining("Install Node.js 22.17.0 or newer"),
  });
  const installed = yield* cli(root, "linux", { checkoutNode: null }).invoke("doctor", "--json");
  expect(checksOf(installed)).not.toHaveProperty("node");
})));

const harnessCases = [
  ["linux", "pi", null],
  ["darwin", "pi", "Install Claude Code"],
  ["win32", "pi", "Install native Claude Code (claude.exe)"],
  ["win32", "claude.cmd", "Install native Claude Code (claude.exe)"],
] as const;

test.each(harnessCases)("doctor checks the supported harness on %s with only %s", (platform, installed, fix) => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();

  const { invoke, commands } = cli(root, platform, {
    which: (name) => name === installed || (installed === "claude.cmd" && name === "claude") ? `${privateMarker}/${installed}` : null,
  });

  const check = checksOf(yield* invoke("doctor", "--json")).ai_harness;
  expect(check).toMatchObject({ required: true, ok: fix === null, fix: fix === null ? null : expect.stringContaining(fix) });
  expect(commands).toEqual([]);
})));

test("doctor probes only the resolved installation root for ntfy presence", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.realPath(".");
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: cwd, prefix: "pulse-doctor-test-" });
  const files = yield* ProfileFiles;
  const root = yield* files.root(temporary);
  const relativeRoot = basename(temporary);
  const probed: string[] = [];

  const { invoke } = cli(root, "linux", {
    hasNtfyTopic: (path) => Effect.sync(() => {
      probed.push(path);

      return path === root;
    }),
  });

  const report = yield* invoke("--root", relativeRoot, "doctor", "--json");
  expect(checksOf(report)).toMatchObject({
    installation_root: { ok: true }, ntfy_topic: { ok: true, required: false },
  });
  expect(report.stdout).not.toContain(root);

  const invalid = yield* invoke("--root", join(relativeRoot, "missing"), "doctor", "--json");
  expect(checksOf(invalid)).toMatchObject({
    installation_root: { ok: false },
    ntfy_topic: { ok: false, required: false, message: "The ntfy topic was not checked because the installation root is invalid." },
  });
  expect(probed).toEqual([root]);
})));

test("doctor handles a fresh checkout; help and invalid arguments do not probe", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const { invoke, commands, writes } = cli(root, "linux", { which: () => null });
  const help = yield* invoke("doctor", "--help");
  expect(help.stdout).toContain("--json");
  expect((yield* invoke("doctor", "--json=true")).exitStatus).toBe(2);
  expect(writes).toEqual([]);
  const text = yield* invoke("doctor");
  expect(text).toMatchObject({ stderr: "", exitStatus: 1 });
  expect(text.stdout).toMatch(/MISSING  profile_selected .*Fix: Run pulse init/u);
  expect(text.stdout).toContain("OPTIONAL  ntfy_topic");
  expect(commands).toEqual([]);
  expect(writes).toHaveLength(1);
  expect(yield* fs.readDirectory(root)).toEqual([]);
})));

test("doctor reports a directory at a configured database path", () => run(Effect.gen(function* () {
  const { root, directory } = yield* syntheticSplit;
  const fs = yield* FileSystem.FileSystem;
  const source = join(root, "data", "source.sqlite3");
  yield* fs.remove(source);
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(join(directory, "review.sqlite3"));
  const { invoke } = cli(root, "linux");
  const checks = checksOf(yield* invoke("--profile", "invented", "doctor", "--json"));

  for (const id of ["data_source", "data_review"]) {
    expect(checks[id]).toMatchObject({ ok: false, fix: expect.stringContaining("database path in profile.toml") });
  }

  expect(checks.data_ledger?.ok).toBe(true);
})));

test("the native write probe cleans up and refuses paths outside the installation", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* ProfileFiles;
  const raw = yield* fs.makeTempDirectoryScoped();
  const root = yield* files.root(raw);
  yield* fs.writeFileString(join(root, "occupied"), privateMarker);
  expect(yield* probeDataDirectory(root, join(root, "missing", "nested"))).toBe(true);
  expect(yield* probeDataDirectory(root, join(root, "occupied", "nested"))).toBe(false);
  expect(yield* probeDataDirectory(root, join(root, ".."))).toBe(false);
  expect(yield* fs.readDirectory(root)).toEqual(["occupied"]);
  expect(yield* fs.readFileString(join(root, "occupied"))).toBe(privateMarker);
})));

test("the native write probe refuses mixed-case repository metadata paths", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* ProfileFiles;
  const raw = yield* fs.makeTempDirectoryScoped();
  const root = yield* files.root(raw);

  for (const name of [".GIT", ".Jj"]) {
    const directory = join(root, name);
    yield* fs.makeDirectory(directory);
    expect(yield* probeDataDirectory(root, directory)).toBe(false);
    expect(yield* fs.readDirectory(directory)).toEqual([]);
  }
})));

test.skipIf(process.platform === "win32")("the native write probe refuses a symlink", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const other = yield* fs.makeTempDirectoryScoped();
  yield* fs.symlink(other, join(root, "alias"));
  expect(yield* probeDataDirectory(root, join(root, "alias", "new"))).toBe(false);
  expect(yield* fs.readDirectory(other)).toEqual([]);
})));

test("the JSON contract matches the Effect Schema and rejects private extra fields", () => {
  expect(schema).toEqual(JSONSchema.make(DoctorReport, { target: "jsonSchema2020-12" }));
  expect(Either.isRight(decode(example))).toBe(true);
  expect(Either.isLeft(decode({ ...example, topic: privateMarker }))).toBe(true);
  expect(Either.isLeft(decode({ ...example, checks: [] }))).toBe(true);
});
