import { CommandExecutor, FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Inspectable, Layer, Predicate, Sink, Stream } from "effect";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { Schedule, type ScheduleInstall } from "../../src/lib/server/orchestration/schedule.ts";
import { makeWindowsSchedule } from "../../src/lib/server/orchestration/schedule-windows.ts";
import { renderWindowsTask, windowsTaskName } from "../../src/lib/server/orchestration/schedule-windows-render.ts";
import { parsePeriod } from "../../src/lib/server/profile/schedule-period.ts";
import { verifyWindowsPrivateDirectory } from "../../src/lib/server/shared/windows-private-files.ts";

const root = "C:\\Pulse & review";
const user = "S-1-5-21-10-20-30-1001";
const whoami = "C:\\Windows\\System32\\whoami.exe";
const schtasks = "C:\\Windows\\System32\\schtasks.exe";
const executable = "C:\\Program Files\\Job Market Pulse\\resources\\pulse.exe";
const profileId = "person";
const name = windowsTaskName(root, profileId, user);
const after = "2026-11-14T23:25:00Z";
const period = (expression: string) => Either.getOrThrow(parsePeriod(expression, "2026-11-13"));
const command = [executable, "--root", root, "--profile", profileId, "run-scheduled"];
const target = { root, profileId, command };

const render = (expression: string, argv = command) => renderWindowsTask({
  command: argv, resolvedRoot: root, profileId, period: period(expression),
}, user, after);

describe("Windows task definition", () => {
  it("renders a direct executable with least privilege, no shell and escaped argv", () => {
    const xml = render("daily 09:00", [...command, "C:\\last\\", "<x>", ""]);
    expect(xml).toContain(`<Command>${executable}</Command>`);
    expect(xml).toContain('<Arguments>"--root" "C:\\Pulse &amp; review" "--profile" "person" "run-scheduled" "C:\\last\\\\" "&lt;x&gt;" ""</Arguments>');
    expect(xml).toContain("<WorkingDirectory>C:\\Pulse &amp; review</WorkingDirectory>");
    expect(xml).toContain(`<UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`);
    expect(xml).toContain('<Actions Context="PulseUser">');
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>false</StartWhenAvailable>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>");
    expect(xml).toContain("<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>");
  });

  it.each([
    ["daily 09:00", "2026-11-15", "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"],
    ["weekly fri 09:00", "2026-11-15", "<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Friday/></DaysOfWeek></ScheduleByWeek>"],
    ["monthly 28 09:00", "2026-11-15", "<ScheduleByMonth><DaysOfMonth><Day>28</Day></DaysOfMonth><Months><January/>"],
    ["every 3 days 09:00", "2026-11-13", "<ScheduleByDay><DaysInterval>3</DaysInterval></ScheduleByDay>"],
    ["every 2 weeks fri 09:00", "2026-11-13", "<ScheduleByWeek><WeeksInterval>2</WeeksInterval><DaysOfWeek><Friday/></DaysOfWeek></ScheduleByWeek>"],
  ])("renders the native recurrence for %s", (expression, date, calendar) => {
    const xml = render(expression);
    expect(xml).toContain(`<StartBoundary>${date}T09:00:00</StartBoundary>${calendar}`);
    expect(xml).not.toContain("--only-if-due");
  });

  it.each(["bun.exe", "C:pulse.exe", "\\pulse.exe", "C:\\%TEMP%\\pulse.exe", "C:\\pulse\n.exe"])("refuses an unsafe executable: %j", (entry) => {
    expect(() => render("daily", [entry])).toThrow();
  });

  it("normalizes Windows identity and isolates installations, profiles and users", () => {
    expect(name).toMatch(/^\\job-market-pulse-person-[a-f0-9]{16}$/u);
    expect(windowsTaskName("c:\\PULSE & REVIEW", "PERSON", user.toLowerCase())).toBe(name);
    expect(windowsTaskName("D:\\Pulse & review", profileId, user)).not.toBe(name);
    expect(windowsTaskName(root, "other", user)).not.toBe(name);
    expect(windowsTaskName(root, profileId, "DESKTOP\\Other")).not.toBe(name);
    expect(() => windowsTaskName(root, "a\\other", user)).toThrow();
  });
});

const setup = (unsafe?: "temp ACL" | "temp inheritance" | "staging ACL") => {
  const calls: string[][] = [];
  const messages: string[] = [];
  const staging: string[] = [];
  const temp = tmpdir();
  const windowsTemp = "C:\\Temp";
  const fullControl = { type: 0, mask: 0x1f01ff, flags: 3, sid: user };

  const verify = (path: string) => {
    const parent = path === temp;
    const windowsPath = parent ? windowsTemp : win32.join(windowsTemp, basename(path));

    return verifyWindowsPrivateDirectory(windowsPath, (paths) => Effect.sync(() => {
      staging.push(parent ? "verify temp" : "verify staging");

      if (!parent) expect(dirname(path)).toBe(temp);

      const aces = paths.map((entry) => {
        if (entry !== windowsPath) return [fullControl];

        if (parent && unsafe === "temp inheritance") return [{ ...fullControl, flags: 0 }];

        if (unsafe === (parent ? "temp ACL" : "staging ACL")) return [fullControl, { ...fullControl, sid: "S-1-1-0" }];

        return [fullControl];
      });

      return { user, entries: aces.map((acl) => ({ directory: true, owner: user, aces: acl })) };
    }));
  };

  let installed = false;
  let answer = "yes";
  let failure = "";
  let definition: Buffer | undefined;
  let registered = render("weekly");

  const executor = CommandExecutor.makeExecutor((task) => Effect.promise(async () => {
    if (!Predicate.isTagged(task, "StandardCommand")) throw new Error("Expected a direct command");
    expect(task.shell).toBe(false);
    let bytes: Buffer;
    let code = 0;

    if (task.command === whoami) {
      expect(task.args).toEqual(["/User", "/FO", "CSV", "/NH"]);
      bytes = Buffer.from(`"DESKTOP\\Example","${user}"\r\n`);
    } else {
      expect(task.command).toBe(schtasks);
      calls.push([...task.args]);
      const verb = task.args[0];
      const exact = verb === "/Query" && task.args.includes("/XML");
      code = verb === failure || (verb === "/Create" && installed) || (exact && !installed) ? 1 : 0;

      if (verb === "/Create") {
        definition = await readFile(task.args[4] ?? "");

        if (code === 0) installed = true;
      }

      if (verb === "/Delete" && code === 0) installed = false;
      const listing = '"\\another-task","N/A","Ready"\r\n' + (installed ? `"${name.toUpperCase()}","N/A","Ready"\r\n` : "");
      bytes = exact ? Buffer.from(`\ufeff${registered}`, "utf16le") : Buffer.from(listing);
    }

    return {
      [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
      pid: CommandExecutor.ProcessId(123), exitCode: Effect.succeed(CommandExecutor.ExitCode(code)),
      isRunning: Effect.succeed(false), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.make(bytes), stderr: Stream.empty,
      toJSON: () => ({}), toString: () => "FakeProcess", [Inspectable.NodeInspectSymbol]: () => ({}),
    };
  }));

  const fs = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (native) => ({
    ...native, realPath: () => Effect.succeed(root),
    makeTempDirectoryScoped: (options) => Effect.sync(() => {
      staging.push("create staging");
      expect(options?.directory).toBe(temp);
    }).pipe(Effect.zipRight(native.makeTempDirectoryScoped(options))),
    writeFile: (path, data, options) => Effect.sync(() => {
      staging.push("write XML");
      expect(options?.flag).toBe("wx");
    }).pipe(Effect.zipRight(native.writeFile(path, data, options))),
  }))).pipe(Layer.provide(BunFileSystem.layer));

  const layer = makeWindowsSchedule(() => ({ whoami, schtasks }), verify).pipe(
    Layer.provide(Layer.merge(fs, Layer.succeed(CommandExecutor.CommandExecutor, executor))),
  );

  const run = <A>(action: (schedule: typeof Schedule.Service) => Effect.Effect<A, unknown>) => Effect.runPromise(Effect.flatMap(Schedule, action).pipe(Effect.provide(layer)));

  const input: ScheduleInstall = {
    ...target, period: period("weekly"), after, available: Effect.succeed(true), ready: Effect.succeed(true),
    io: { say: (text) => Effect.sync(() => { messages.push(text); }), ask: (text) => Effect.sync(() => {
      messages.push(text);

      return answer;
    }) },
  };

  return { calls, messages, staging, input, run, definition: () => definition, answer: (text: string) => { answer = text; }, fail: (verb: string) => { failure = verb; }, addTask: (xml = render("weekly")) => { installed = true; registered = xml; } };
};

const query = ["/Query", "/FO", "CSV", "/NH"];
const exact = ["/Query", "/TN", name, "/XML"];

describe("Windows scheduler lifecycle with a fake executor", () => {
  it("uses only the selected task for create, query, run and delete", async () => {
    const t = setup();
    expect(await t.run((s) => s.status(target))).toEqual({ installed: false, partial: false });
    expect(await t.run((s) => s.install(t.input))).toBe(true);
    const create = t.calls.at(-1);
    expect(create).toEqual(["/Create", "/TN", name, "/XML", expect.stringMatching(/\.xml$/u)]);
    expect(t.definition()?.toString("utf16le")).toBe(`\ufeff${render("weekly")}`);
    expect(t.staging).toEqual(["verify temp", "create staging", "verify staging", "write XML"]);
    await expect(access(dirname(create?.[4] ?? ""))).rejects.toThrow();
    expect(await t.run((s) => s.status(target))).toEqual({ installed: true, partial: false, next: "unknown", last: "unknown" });
    expect(await t.run((s) => s.runNow(t.input))).toBe(true);
    expect(await t.run((s) => s.remove(t.input))).toBe(true);
    expect(await t.run((s) => s.status(target))).toEqual({ installed: false, partial: false });
    expect(t.calls).toEqual([query, query, create, query, exact, exact, exact, ["/Run", "/TN", name], query, exact, exact, ["/Delete", "/TN", name, "/F"], query]);
  });

  it("requires exact confirmation before creation, removal and run", async () => {
    const t = setup();
    t.answer("Yes");
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    t.addTask();
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect(await t.run((s) => s.runNow(t.input))).toBe(false);
    expect(t.calls).toEqual([query, query, exact, exact]);
    expect(t.staging).toEqual([]);
  });

  it.each([
    ["temp ACL", ["verify temp"]],
    ["temp inheritance", ["verify temp"]],
    ["staging ACL", ["verify temp", "create staging", "verify staging"]],
  ] as const)("does not write XML or request /Create with unsafe %s", async (unsafe, staging) => {
    const t = setup(unsafe);
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls).toEqual([query]);
    expect(t.staging).toEqual(staging);
    expect(t.messages.at(-1)).toContain("Cannot verify private NTFS storage");
  });

  it.each([["install", "install and enable this task"], ["runNow", "request a run"]] as const)("describes conditional ntfy delivery before %s asks for consent", async (method, prompt) => {
    const t = setup();
    t.answer("no");

    if (method === "runNow") t.addTask();

    expect(await t.run((s) => s[method](t.input))).toBe(false);
    expect(t.messages.at(-1)).toBe(`Type yes to ${prompt}:`);
    expect(t.messages.at(-2)).toMatch(/If phone notifications are enabled.*job titles, employers and the dashboard link.*fixed failure notice.*ntfy\.sh/u);
  });

  it.each(["ready", "available"] as const)("checks %s before invoking Task Scheduler", async (gate) => {
    const t = setup();
    expect(await t.run((s) => s.install({ ...t.input, [gate]: Effect.succeed(false) }))).toBe(false);
    expect(t.calls).toEqual([]);
  });

  it("does not replace a registered task", async () => {
    const t = setup();
    t.addTask();
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls).toEqual([query]);
  });

  it("does not report an unsuccessful query as absence", async () => {
    const t = setup();
    t.fail("/Query");
    await expect(t.run((s) => s.status(target))).rejects.toThrow();
    expect(await t.run((s) => s.remove(t.input))).toBe(false);
    expect(t.calls).toEqual([query, query]);
  });

  it.each([
    render("weekly").replace(executable, "C:\\other.exe"),
    render("weekly").replace(user, "S-1-5-18"),
    render("weekly").replace("</Actions>", "<ComHandler/></Actions>"),
  ])("does not trust a same-name task with an unexpected action or principal", async (xml) => {
    const t = setup();
    const input = { ...t.input, io: { ...t.input.io, ask: () => Effect.dieMessage("Must not ask") } };
    t.addTask(xml);
    await expect(t.run((s) => s.status(target))).rejects.toThrow();
    expect(await t.run((s) => s.runNow(input))).toBe(false);
    expect(await t.run((s) => s.remove(input))).toBe(false);
    expect(t.calls).toEqual([query, exact, exact, query, exact]);
  });

  it.each(["runNow", "remove"] as const)("rechecks the action after confirming %s", async (method) => {
    const t = setup();
    t.addTask();

    const input = { ...t.input, io: { ...t.input.io, ask: () => Effect.sync(() => {
      t.addTask(render("weekly").replace(executable, "C:\\other.exe"));

      return "yes";
    }) } };

    expect(await t.run((s) => s[method](input))).toBe(false);
    expect(t.calls).toEqual(method === "remove" ? [query, exact, exact] : [exact, exact]);
  });

  it("does not replace or delete a task registered during confirmation", async () => {
    const t = setup();

    const input = { ...t.input, io: { ...t.input.io, ask: () => Effect.sync(() => {
      t.addTask();

      return "yes";
    }) } };

    expect(await t.run((s) => s.install(input))).toBe(false);
    expect(t.calls).toEqual([query, ["/Create", "/TN", name, "/XML", expect.any(String)]]);
    expect((await t.run((s) => s.status(target))).installed).toBe(true);
  });

  it("cleans up temporary XML after a failed registration and does not delete any task", async () => {
    const t = setup();
    t.fail("/Create");
    expect(await t.run((s) => s.install(t.input))).toBe(false);
    expect(t.calls.map(([verb]) => verb)).toEqual(["/Query", "/Create"]);
    await expect(access(t.calls.at(-1)?.[4] ?? "")).rejects.toThrow();
  });
});
