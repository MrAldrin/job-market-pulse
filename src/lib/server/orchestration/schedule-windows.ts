import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { verifyWindowsPrivateDirectory } from "../shared/windows-private-files.ts";
import { Schedule, ScheduleError, type ScheduleTarget } from "./schedule.ts";
import { matchesWindowsTask, renderWindowsTask, windowsTaskName } from "./schedule-windows-render.ts";

const fail = (message: string) => new ScheduleError({ message });
const invalidTarget = () => fail("Cannot resolve the Windows installation root, profile or current user.");
const notificationConsent = "If phone notifications are enabled, Pulse can send job titles, employers and the dashboard link for new exceptional matches, or a fixed failure notice, to ntfy.sh.";

const windowsHost = () => {
  const systemRoot = process.env.SystemRoot;

  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error("Missing Windows system root");
  const directory = win32.join(systemRoot, "System32");

  return { schtasks: win32.join(directory, "schtasks.exe"), whoami: win32.join(directory, "whoami.exe") };
};

export const makeWindowsSchedule = (host = windowsHost, verifyDirectory: (path: string) => Effect.Effect<void, unknown> = verifyWindowsPrivateDirectory) => Layer.effect(Schedule, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executor = yield* CommandExecutor.CommandExecutor;

  const invoke = (exe: string, tool: string, ...args: string[]) => Effect.scoped(Effect.gen(function* () {
    const child = yield* executor.start(Command.make(exe, ...args).pipe(Command.stdin(Stream.empty), Command.stdout("pipe"), Command.stderr("pipe")));

    const [code, output] = yield* Effect.all([
      child.exitCode,
      Stream.runCollect(child.stdout),
      child.stderr.pipe(Stream.runDrain),
    ], { concurrency: "unbounded" });

    if (code !== 0) return yield* fail(`${tool} did not accept the command. Check the task before retrying.`);

    const bytes = Buffer.concat(Array.from(output));

    const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
      : bytes[1] === 0 || (bytes[0] === 0xff && bytes[1] === 0xfe) ? "utf-16le" : "utf-8";

    return new TextDecoder(encoding).decode(bytes);
  })).pipe(
    Effect.catchAll((error) => Effect.fail(error instanceof ScheduleError ? error : fail(`Cannot access ${tool}.`))),
    Effect.timeoutFail({ duration: "30 seconds", onTimeout: () => fail(`${tool} command timed out. Check the task before retrying.`) }),
  );

  const taskCommand = (exe: string, ...args: string[]) => invoke(exe, "Task Scheduler", ...args);

  const target = (input: ScheduleTarget) => Effect.gen(function* () {
    const root = yield* fs.realPath(input.root).pipe(Effect.mapError(invalidTarget));
    const { schtasks, whoami } = yield* Effect.try({ try: host, catch: invalidTarget });
    const account = yield* invoke(whoami, "whoami", "/User", "/FO", "CSV", "/NH");
    const user = /[,;]"(S-1-(?:\d+-)*\d+)"\s*$/u.exec(account)?.[1];

    if (!user) return yield* invalidTarget();
    const name = yield* Effect.try({ try: () => windowsTaskName(root, input.profileId, user), catch: invalidTarget });

    return { root, name, user, schtasks };
  });

  const verify = (task: { root: string; name: string; user: string; schtasks: string }, command: readonly string[] | undefined) => Effect.gen(function* () {
    const definition = yield* taskCommand(task.schtasks, "/Query", "/TN", task.name, "/XML");

    if (!command || !matchesWindowsTask(definition, task.root, command, task.user)) {
      return yield* fail("The registered task does not match this Pulse launcher and user. Inspect it in Task Scheduler.");
    }
  });

  // Query visible task names instead of guessing why a targeted /Query failed
  // from its localized text or its non-specific nonzero exit code.
  const exists = (exe: string, name: string) => taskCommand(exe, "/Query", "/FO", "CSV", "/NH").pipe(Effect.map((output) =>
    output.split(/\r?\n/u).some((line) => /^"([^"]*)"[,;]/u.exec(line)?.[1]?.toLowerCase() === name.toLowerCase()),
  ));

  return {
    install: (input) => Effect.gen(function* () {
      if (!(yield* input.available)) return yield* fail("run-scheduled is not available. Use pulse refresh manually.");

      if (!(yield* input.ready)) return yield* fail("Schedule needs a ready profile, private NTFS storage and native Claude Code. See pulse doctor and status.");
      const task = yield* target(input);

      const definition = yield* Effect.try({
        try: () => renderWindowsTask({ ...input, resolvedRoot: task.root }, task.user, input.after),
        catch: () => fail("Cannot render the task. Check the local drive paths, command, user and period."),
      });

      if (yield* exists(task.schtasks, task.name)) return yield* fail("Task already exists. Remove this profile's task first.");

      yield* input.io.say(`Task ${task.name}:\n${definition}`);
      yield* input.io.say("The task uses the Windows local clock. It must follow Norway time. It runs only while this user is signed in. Each run refreshes source data and uses the configured models. It uploads only a completed snapshot and only if configured.");
      yield* input.io.say(notificationConsent);

      if ((yield* input.io.ask("Type yes to install and enable this task:")).trim() !== "yes") return false;

      yield* Effect.scoped(Effect.gen(function* () {
        const temp = tmpdir();

        const check = (path: string) => verifyDirectory(path).pipe(
          Effect.mapError(() => fail("Cannot verify private NTFS storage for the temporary task definition.")),
        );

        yield* check(temp);
        const directory = yield* fs.makeTempDirectoryScoped({ directory: temp, prefix: "pulse-task-" });
        yield* check(directory);
        const file = join(directory, "task.xml");

        yield* fs.writeFile(file, Buffer.from(`\ufeff${definition}`, "utf16le"), { flag: "wx" });
        // Do not use /F. A task created after the query must not be overwritten.
        yield* taskCommand(task.schtasks, "/Create", "/TN", task.name, "/XML", file);
      })).pipe(Effect.catchTags({
        BadArgument: () => Effect.fail(fail("Cannot write the temporary task definition.")),
        SystemError: () => Effect.fail(fail("Cannot write the temporary task definition.")),
      }));

      yield* input.io.say("Task installed and enabled.");

      return true;
    }).pipe(Effect.catchAll((error) => input.io.say(`Schedule blocked: ${error.message}`).pipe(Effect.as(false)))),
    status: (input) => Effect.gen(function* () {
      const task = yield* target(input);
      const installed = yield* exists(task.schtasks, task.name);

      if (!installed) return { installed, partial: false };
      yield* verify(task, input.command);

      return { installed, partial: false, next: "unknown", last: "unknown" };
    }),
    remove: (input) => Effect.gen(function* () {
      const task = yield* target(input);

      if (!(yield* exists(task.schtasks, task.name))) {
        yield* input.io.say("Nothing is installed.");

        return true;
      }

      yield* verify(task, input.command);
      yield* input.io.say(`Remove ${task.name}. This does not stop a refresh that has already started.`);

      if ((yield* input.io.ask("Type yes to remove this task:")).trim() !== "yes") return false;

      yield* verify(task, input.command);
      yield* taskCommand(task.schtasks, "/Delete", "/TN", task.name, "/F");
      yield* input.io.say("Task removed.");

      return true;
    }).pipe(Effect.catchAll((error) => input.io.say(`Removal blocked: ${error.message}`).pipe(Effect.as(false)))),
    runNow: (input) => Effect.gen(function* () {
      const task = yield* target(input);
      yield* verify(task, input.command);
      yield* input.io.say(`Request an immediate run of ${task.name}. It may refresh live data, use models and upload a snapshot.`);
      yield* input.io.say(notificationConsent);

      if ((yield* input.io.ask("Type yes to request a run:")).trim() !== "yes") return false;

      yield* verify(task, input.command);
      yield* taskCommand(task.schtasks, "/Run", "/TN", task.name);
      yield* input.io.say("Task run requested. This does not confirm a refresh completed.");

      return true;
    }).pipe(Effect.catchAll((error) => input.io.say(`Run blocked: ${error.message}`).pipe(Effect.as(false)))),
  };
}));

export const WindowsScheduleLive = makeWindowsSchedule();
