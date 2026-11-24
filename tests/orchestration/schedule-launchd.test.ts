import { CommandExecutor } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { DOMParser } from "@xmldom/xmldom";
import { Effect, Either, Inspectable, Layer, Predicate, Sink, Stream } from "effect";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchdArguments, launchdLabel, renderLaunchd } from "../../src/lib/server/orchestration/schedule-launchd-render.ts";
import { makeLaunchdSchedule } from "../../src/lib/server/orchestration/schedule-launchd.ts";
import { Schedule, type ScheduleInstall } from "../../src/lib/server/orchestration/schedule.ts";
import { parsePeriod } from "../../src/lib/server/profile/schedule-period.ts";

const period = (text: string) => Either.getOrThrow(parsePeriod(text, "2026-11-14"));

const render = {
  resolvedRoot: '/fake/Job & <Market> "Pulse"', profileId: "person", command: ["/fake/bin/bun", "/fake/Pulse checkout/src/cli/pulse.ts", "$HOME; literal"],
  searchPath: "/fake/tools & utilities:/usr/bin", period: period("every 2 weeks sun 16:15"),
};

it("renders literal XML argv and an anchored fortnightly calendar without running on load", () => {
  const doc = new DOMParser().parseFromString(renderLaunchd(render), "text/xml");
  const values = Array.from(doc.getElementsByTagName("string"), (node) => node.textContent);
  expect(values).toEqual([
    launchdLabel(render.resolvedRoot, "person"), render.resolvedRoot, ...render.command,
    "--only-if-due", "--period", "every 2 weeks sun 16:15", "--anchor", "2026-11-15", render.searchPath,
  ]);
  expect(Array.from(doc.getElementsByTagName("integer"), (node) => node.textContent)).toEqual(["63", "16", "15", "0"]);
  expect(doc.documentElement?.textContent).not.toMatch(/RunAtLoad|KeepAlive/);
  expect(launchdLabel(render.resolvedRoot, "other")).not.toBe(values[0]);
  expect(launchdLabel("/fake/other", "person")).not.toBe(values[0]);
});

it("renders daily, monthly and anchored every-N-days calendar fields", () => {
  expect(renderLaunchd({ ...render, period: period("daily 16:00") })).not.toMatch(/Weekday|<key>Day|--only-if-due/);
  expect(renderLaunchd({ ...render, period: period("monthly 12 16:00") })).toContain("<key>Day</key><integer>12</integer>");
  const interval = renderLaunchd({ ...render, period: period("every 3 days 16:00") });
  expect(interval).not.toMatch(/Weekday|<key>Day/);
  expect(interval).toContain("<string>--only-if-due</string><string>--period</string><string>every 3 days 16:00</string>");
  expect(() => renderLaunchd({ ...render, command: ["bun"] })).toThrow(/absolute/);
  expect(() => renderLaunchd({ ...render, command: ["/fake/bun", "bad\u0000arg"] })).toThrow(/character/);
});

const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "pulse-launchd-"));
  roots.push(root);
  const home = await realpath(root);
  const directory = join(home, "Library", "LaunchAgents");
  const domain = "gui/501";
  const label = launchdLabel(home, "person");
  const service = `${domain}/${label}`;
  const path = join(directory, `${label}.plist`);
  const calls: string[][] = [];
  const command = ["/fake/bin/bun", "run-scheduled"];
  const expected = launchdArguments(command, render.period);
  const environment = (value: string) => `\tenvironment = {\n\t\tPATH => ${value}\n\t}\n`;
  const state = { answer: "yes", domain: true, loaded: false, fail: "", loadedAction: expected, loadedPath: path, loadedRoot: home, environment: environment(render.searchPath) };
  const messages: string[] = [];

  const executor = CommandExecutor.makeExecutor((command) => Effect.sync(() => {
    if (!Predicate.isTagged(command, "StandardCommand")) throw new Error("Expected one command");
    expect(command.command).toBe("/bin/launchctl");
    calls.push([...command.args]);
    const [action, target] = command.args;
    let ok = action !== state.fail;

    if (action === "print") ok = target === domain ? state.domain : state.loaded && state.fail !== "lookup";

    if (ok && action === "bootstrap") state.loaded = true;

    if (ok && action === "bootout") state.loaded = false;

    const absent = `Could not find service "${label}" in domain for user gui: 501`;
    const stderr = !ok && action === "print" && target === service ? (state.fail === "lookup" ? "Access denied" : absent) : "";

    const stdout = ok && action === "print" && target === service
      ? `${service} = {\n\tpath = ${state.loadedPath}\n\tprogram = ${state.loadedAction[0]}\n\targuments = {\n${state.loadedAction.map((arg) => `\t\t${arg}\n`).join("")}\t}\n\tworking directory = ${state.loadedRoot}\n\tinherited environment = {\n\t\tHOME => /fake\n\t}\n\tdefault environment = {\n\t\tPATH => /usr/bin\n\t}\n${state.environment}}\n`
      : "";

    return {
      [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
      pid: CommandExecutor.ProcessId(123), exitCode: Effect.succeed(CommandExecutor.ExitCode(ok ? 0 : 1)),
      isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain, stdout: Stream.make(new TextEncoder().encode(stdout)), stderr: Stream.make(new TextEncoder().encode(stderr)),
      toJSON: () => ({}), toString: () => "FakeProcess", [Inspectable.NodeInspectSymbol]: () => ({}),
    };
  }));

  const layer = makeLaunchdSchedule(() => ({ uid: 501, homedir: home })).pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, Layer.succeed(CommandExecutor.CommandExecutor, executor))),
  );

  const run = <A>(action: (s: typeof Schedule.Service) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(Effect.flatMap(Schedule, action).pipe(Effect.provide(layer)));

  const input = {
    root, profileId: "person", period: render.period, command, searchPath: render.searchPath,
    after: "2026-11-14T00:00:00Z", ready: Effect.succeed(true), available: Effect.succeed(true),
    io: { say: (message: string) => Effect.sync(() => { messages.push(message); }), ask: () => Effect.sync(() => state.answer) },
  } satisfies ScheduleInstall;

  return { run, input, action: { ...input, command: expected }, state, calls, directory, domain, service, path, environment, messages };
};

describe.skipIf(process.platform === "win32")("LaunchAgent lifecycle with a fake executor", () => {
  it("installs, starts without killing an existing run, and removes only the selected plist", async () => {
    const t = await setup();
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: false, partial: false });
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    expect(t.calls.at(-1)).toEqual(["bootstrap", t.domain, t.path]);
    expect((await stat(t.path)).mode & 0o777).toBe(0o600);
    const other = join(t.directory, "other.plist");
    await writeFile(other, "keep");
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: true, partial: false });
    expect(await t.run((s) => s.runNow(t.action))).toBe(true);
    expect(t.calls.at(-1)).toEqual(["kickstart", t.service]);
    expect(await t.run((s) => s.remove(t.input))).toBe(true);
    expect(t.calls.at(-1)).toEqual(["bootout", t.service]);
    expect(await readFile(other, "utf8")).toBe("keep");
    await expect(stat(t.path)).rejects.toThrow();
  });

  it("requires typed confirmation for all three mutations", async () => {
    const t = await setup();
    t.state.answer = "Yes";
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    await expect(stat(t.path)).rejects.toThrow();
    t.state.answer = "yes";
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    t.calls.length = 0;
    t.state.answer = "no";
    expect(await t.run((s) => s.runNow(t.action))).toBe(false);
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect(t.calls.every(([action]) => action === "print")).toBe(true);
  });

  it.each(["program", "argv", "root", "plist", "changed after prompt"])("refuses a same-label action mismatch: %s", async (mismatch) => {
    const t = await setup();
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    const wrong = ["/fake/other", ...t.action.command.slice(1)];

    if (mismatch === "program") t.state.loadedAction = wrong;

    if (mismatch === "argv") t.state.loadedAction = [...t.action.command, "--extra"];

    if (mismatch === "root") t.state.loadedRoot = "/fake/other-root";

    if (mismatch === "plist") t.state.loadedPath = "/fake/other.plist";

    let asked = false;

    const action = { ...t.action, io: { ...t.action.io, ask: () => Effect.sync(() => {
      asked = true;
      t.state.loadedAction = wrong;

      return "yes";
    }) } };

    expect(await t.run((s) => s.runNow(action))).toBe(false);
    expect(asked).toBe(mismatch === "changed after prompt");
    expect(t.calls.some(([verb]) => verb === "kickstart")).toBe(false);
  });

  it.each([false, true])("refuses a PATH-only change (during confirmation: %s)", async (duringConfirmation) => {
    const t = await setup();
    expect(await t.run((s) => s.install(t.input))).toBe(true);

    const changePath = () => { t.state.environment = t.environment("/fake/other:/usr/bin"); };

    if (!duringConfirmation) changePath();

    let asked = false;

    const io = { ...t.action.io, ask: () => Effect.sync(() => {
      asked = true;
      changePath();

      return "yes";
    }) };

    expect(await t.run((s) => s.runNow({ ...t.action, io }))).toBe(false);
    expect(asked).toBe(duringConfirmation);
    expect(t.calls.some(([verb]) => verb === "kickstart")).toBe(false);
  });

  it.each(["missing", "extra variable", "duplicate block", "unknown syntax"] as const)("refuses unsafe environment output: %s", async (variant) => {
    const t = await setup();
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    const block = t.state.environment;

    const variants = {
      missing: "",
      "extra variable": block.replace("\t}\n", "\t\tBUN_OPTIONS => --preload /fake/other.ts\n\t}\n"),
      "duplicate block": block + block,
      "unknown syntax": block.replace(" => ", " = "),
    };

    t.state.environment = variants[variant];
    const ask = () => Effect.die("An unknown environment must block before confirmation");

    expect(await t.run((s) => s.runNow({ ...t.action, io: { ...t.action.io, ask } }))).toBe(false);
    expect(t.calls.some(([verb]) => verb === "kickstart")).toBe(false);
  });

  it("rejects an unsafe PATH before install consent", async () => {
    const t = await setup();
    const ask = () => Effect.die("An unsafe PATH must block before confirmation");
    const input = { ...t.input, searchPath: "/fake/tools:\u0085:/usr/bin", io: { ...t.input.io, ask } };

    expect(await t.run((s) => s.install(input))).toBe(false);
    expect(t.calls).toEqual([]);
    await expect(stat(t.path)).rejects.toThrow();
  });

  it("discloses conditional ntfy data before install and run-now consent", async () => {
    const t = await setup();
    let prompts = 0;
    const notice = "If ntfy notifications are enabled, a run can send job titles and employer names and can include a dashboard link. A failed run can send a failure notice.";

    const io = { ...t.input.io, ask: () => Effect.sync(() => {
      expect(t.messages.at(-1)).toContain(notice);
      prompts += 1;

      return "yes";
    }) };

    expect(await t.run((s) => s.install({ ...t.input, io }))).toBe(true);
    expect(await t.run((s) => s.runNow({ ...t.action, io }))).toBe(true);
    expect(prompts).toBe(2);
  });

  it.each([false, true])("preserves the plist when a different registration is seen (after prompt: %s)", async (afterPrompt) => {
    const t = await setup();
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    const other = "/fake/other.plist";

    if (!afterPrompt) t.state.loadedPath = other;

    const io = { ...t.input.io, ask: () => Effect.sync(() => {
      t.state.loadedPath = other;

      return "yes";
    }) };

    expect(await t.run((s) => s.remove({ ...t.input, io }))).toBe(false);
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: false, partial: true });
    expect((await stat(t.path)).isFile()).toBe(true);
    expect(t.calls.some(([verb]) => verb === "bootout")).toBe(false);
  });

  it("reports partial state after load failure and keeps the plist on unload failure", async () => {
    const t = await setup();
    t.state.fail = "bootstrap";
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: false, partial: true });
    t.state.loaded = true;
    t.state.fail = "bootout";
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect((await stat(t.path)).isFile()).toBe(true);
    t.state.fail = "lookup";
    expect(await t.run((s) => s.status(t.input))).toMatchObject({ installed: false, partial: true, error: expect.any(String) });
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect((await stat(t.path)).isFile()).toBe(true);
    t.state.domain = false;
    expect(await t.run((s) => s.status(t.input))).toMatchObject({ installed: false, partial: true, error: expect.any(String) });
  });

  it("preserves a pre-existing file and refuses a linked plist", async () => {
    const t = await setup();
    await mkdir(t.directory, { recursive: true });
    await writeFile(t.path, "existing");
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(await readFile(t.path, "utf8")).toBe("existing");
    await rm(t.path);
    await symlink(join(t.directory, "missing.plist"), t.path);
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls).toEqual([]);
  });
});
