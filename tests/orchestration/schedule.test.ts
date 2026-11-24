import { CommandExecutor } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, HashMap, Inspectable, Layer, Option, Predicate, Sink, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schedule, ScheduleLive, type ScheduleInstall } from "../../src/lib/server/orchestration/schedule.ts";
import { unitNames } from "../../src/lib/server/orchestration/schedule-render.ts";
import { parsePeriod } from "../../src/lib/server/profile/schedule-period.ts";
import { Either } from "effect";

const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const setup = async (failure = "", output?: string) => {
  const root = await mkdtemp(join(tmpdir(), "pulse-schedule-"));
  roots.push(root);
  const calls: string[][] = [];
  const messages: string[] = [];
  let answer = "yes";

  const executor = CommandExecutor.makeExecutor((command) => Effect.sync(() => {
    if (!Predicate.isTagged(command, "StandardCommand")) throw new Error("Unexpected pipe");
    expect(command.command).toBe("systemctl");
    expect(Option.getOrThrow(HashMap.get(command.env, "LC_ALL"))).toBe("C");
    calls.push([command.command, ...command.args]);
    const timer = unitNames(root, "person")[1];
    const text = output ?? `NEXT LEFT LAST PASSED UNIT\nSun 2026-11-15 09:00:00 CET 1 day Fri 2026-11-13 09:00:00 CET 1 day ${timer}\n`;

    return {
      [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
      pid: CommandExecutor.ProcessId(123),
      exitCode: Effect.succeed(CommandExecutor.ExitCode(failure && command.args.includes(failure) ? 1 : 0)),
      isRunning: Effect.succeed(false), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.make(new TextEncoder().encode(text)), stderr: Stream.empty,
      toJSON: () => ({}), toString: () => "FakeProcess", [Inspectable.NodeInspectSymbol]: () => ({}),
    };
  }));

  const layer = ScheduleLive.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Layer.succeed(CommandExecutor.CommandExecutor, executor))));
  const run = <A>(action: (schedule: typeof Schedule.Service) => Effect.Effect<A, unknown>) => Effect.runPromise(Effect.flatMap(Schedule, action).pipe(Effect.provide(layer)));

  const input = {
    root, profileId: "person", unitDir: join(root, "units"),
    period: Either.getOrThrow(parsePeriod("weekly", "2026-11-14")),
    command: ["/synthetic/bin/bun", join(root, "src/cli/pulse.ts"), "--profile", "person", "run-scheduled"],
    after: "2026-11-14T00:00:00Z", ready: Effect.succeed(true), available: Effect.succeed(true),
    io: { say: (text) => Effect.sync(() => { messages.push(text); }), ask: (text) => Effect.sync(() => {
      messages.push(text);

      return answer;
    }) },
  } satisfies ScheduleInstall;

  return { root, calls, messages, input, run, answer: (text: string) => { answer = text; } };
};

describe.skipIf(process.platform === "win32")("systemd schedule lifecycle with fake CommandExecutor", () => {
  it("installs TS argv, reports status and removes only its own units", async () => {
    const t = await setup();
    expect(await t.run((s) => s.install({ ...t.input, searchPath: "/invented/bin:/usr/bin" }))).toBe(true);
    const [service, timer] = unitNames(t.root, "person");

    for (const name of [service, timer]) expect((await stat(join(t.input.unitDir, name))).mode & 0o777).toBe(0o644);
    const unit = await readFile(join(t.input.unitDir, service), "utf8");
    expect(unit).toContain('Environment="PATH=/invented/bin:/usr/bin"\n');
    expect(unit).toContain('ExecStart="/synthetic/bin/bun"');
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: true, partial: false, next: "Sun 2026-11-15 09:00:00 CET", last: "Fri 2026-11-13 09:00:00 CET" });
    await writeFile(join(t.input.unitDir, "other.timer"), "keep");
    t.answer("no");
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    t.answer("yes");
    expect(await t.run((s) => s.remove(t.input))).toBe(true);
    expect(await readdir(t.input.unitDir)).toEqual(["other.timer"]);
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: false, partial: false });
    expect(t.calls.at(-2)).toEqual(["systemctl", "--user", "disable", "--now", timer]);
  });
  it("starts the installed service only with confirmation", async () => {
    const t = await setup();
    expect(await t.run((s) => s.runNow(t.input))).toBe(false);
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    t.answer("no");
    expect(await t.run((s) => s.runNow(t.input))).toBe(false);
    expect(t.calls.some((args) => args.includes("start"))).toBe(false);
    t.answer("yes");
    expect(await t.run((s) => s.runNow(t.input))).toBe(true);
    expect(t.calls.at(-1)).toEqual(["systemctl", "--user", "start", "--no-block", unitNames(t.root, "person")[0]]);
  });
  it.each(["no", "Yes", "", "y"])("requires exact typed yes: %s", async (answer) => {
    const t = await setup(); t.answer(answer);
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls).toEqual([["systemctl", "--user", "show-environment"]]);
    await expect(stat(t.input.unitDir)).rejects.toThrow();
  });
  it("discloses conditional ntfy content before install and run-now confirmation", async () => {
    const t = await setup();
    const notice = "If you enable ntfy notifications, a run can send job titles and employers with a dashboard link, or a failure notice, through ntfy.sh.";
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    const installPrompt = t.messages.indexOf("Type yes to install and enable this timer:");
    expect(t.messages[installPrompt - 1]).toContain(notice);

    t.answer("no");
    expect(await t.run((s) => s.runNow(t.input))).toBe(false);
    expect(t.messages.at(-2)).toContain(notice);
    expect(t.messages.at(-1)).toBe("Type yes to start the timer service:");
    expect(t.calls.some((args) => args.includes("start"))).toBe(false);
  });
  it("accepts whitespace around yes", async () => {
    const t = await setup(); t.answer(" yes \n");
    expect(await t.run((s) => s.install(t.input))).toBe(true);
  });
  it.each(["ready", "available"] as const)("refuses failed %s before commands", async (gate) => {
    const t = await setup();
    expect(await t.run((s) => s.install({ ...t.input, [gate]: Effect.succeed(false) }))).toBe(false);
    expect(t.calls).toEqual([]);
  });
  it.each(["show-environment", "daemon-reload", "enable"])("rolls back %s failure", async (failure) => {
    const t = await setup(failure);
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(await readdir(t.input.unitDir).catch(() => [])).toEqual([]);
    expect(t.calls.some((args) => args.includes("disable"))).toBe(failure === "enable");
  });
  it("preserves existing and racing units without override", async () => {
    const t = await setup();
    await mkdir(t.input.unitDir);
    const path = join(t.input.unitDir, unitNames(t.root, "person")[0]);
    await writeFile(path, "existing");
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls).toEqual([]);
    await rm(path);

    const io = { ...t.input.io, ask: () => Effect.promise(async () => {
      await writeFile(path, "racing");

      return "yes";
    }) };

    expect(await t.run((s) => s.install({ ...t.input, io }))).toBe(false);
    expect(await readFile(path, "utf8")).toBe("racing");
  });
  it("rolls back its first file when the second unit races installation", async () => {
    const t = await setup();
    const [service, timer] = unitNames(t.root, "person");

    const io = { ...t.input.io, ask: () => Effect.promise(async () => {
      await mkdir(t.input.unitDir);
      await writeFile(join(t.input.unitDir, timer), "racing timer");

      return "yes";
    }) };

    expect(await t.run((s) => s.install({ ...t.input, io }))).toBe(false);
    expect(await readdir(t.input.unitDir)).toEqual([timer]);
    expect(await readFile(join(t.input.unitDir, timer), "utf8")).toBe("racing timer");
    await expect(stat(join(t.input.unitDir, service))).rejects.toThrow();
    expect(t.calls.some((args) => args.includes("enable"))).toBe(false);
  });
  it("preserves both units if disable fails", async () => {
    const t = await setup("disable");
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect(await readdir(t.input.unitDir)).toHaveLength(2);
  });
  it("refuses system-wide locations", async () => {
    const t = await setup();
    expect(await t.run((s) => s.install({ ...t.input, unitDir: "/etc/systemd/user" }))).toBe(false);
    expect(t.calls).toEqual([]);
  });
  it("reports partial installs and unknown runtime columns", async () => {
    const t = await setup("", "unrecognized output");
    await mkdir(t.input.unitDir);
    await writeFile(join(t.input.unitDir, unitNames(t.root, "person")[0]), "partial");
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: false, partial: true, next: "unknown", last: "unknown" });
  });
  it("reports unavailable runtime without fabricating timestamps", async () => {
    const t = await setup("list-timers");
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    expect(await t.run((s) => s.status(t.input))).toEqual({ installed: true, partial: false, error: "User systemd is unavailable; timer runtime is unknown." });
  });
  it("binds root symlinks to the same physical installation", async () => {
    const t = await setup();
    const alias = join(t.root, "alias"); await symlink(t.root, alias);
    expect(await t.run((s) => s.install({ ...t.input, root: alias }))).toBe(true);
    expect(await t.run((s) => s.status(t.input))).toMatchObject({ installed: true });
    expect((await readdir(t.input.unitDir)).sort()).toEqual([...unitNames(t.root, "person")].sort());
  });
});
