import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Layer, Stream } from "effect";
import { isAbsolute, join } from "node:path";
import { physicalPath } from "../shared/paths.ts";
import { renderUnits, showSchedule, unitNames, type ScheduleRenderInput } from "./schedule-render.ts";

export class ScheduleError extends Data.TaggedError("ScheduleError")<{ readonly message: string }> {}

export interface SchedulePrompt {
  readonly say: (text: string) => Effect.Effect<void, ScheduleError>;
  readonly ask: (text: string) => Effect.Effect<string, ScheduleError>;
}

export interface ScheduleTarget {
  readonly root: string;
  readonly profileId: string;
  /** Required only by the systemd adapter. */
  readonly unitDir?: string;
  /** Expected action for identifying a registered Windows task or LaunchAgent. */
  readonly command?: readonly string[];
  readonly searchPath?: string;
}

export interface ScheduleInstall extends ScheduleTarget {
  readonly period: ScheduleRenderInput["period"];
  // TS callers supply absolute Bun + the TS CLI argv, not the legacy Python launcher.
  readonly command: readonly string[];
  readonly after: string;
  readonly io: SchedulePrompt;
  readonly available: Effect.Effect<boolean, ScheduleError>;
  readonly ready: Effect.Effect<boolean, ScheduleError>;
}

export interface ScheduleStatus {
  readonly installed: boolean;
  readonly partial: boolean;
  readonly next?: string;
  readonly last?: string;
  readonly error?: string;
}

export class Schedule extends Context.Tag("pulse/Schedule")<Schedule, {
  readonly install: (input: ScheduleInstall) => Effect.Effect<boolean, ScheduleError>;
  readonly remove: (input: ScheduleTarget & { readonly io: SchedulePrompt }) => Effect.Effect<boolean, ScheduleError>;
  readonly runNow: (input: ScheduleTarget & { readonly io: SchedulePrompt }) => Effect.Effect<boolean, ScheduleError>;
  readonly status: (input: ScheduleTarget) => Effect.Effect<ScheduleStatus, ScheduleError>;
}>() {}

const blocked = (message: string) => new ScheduleError({ message });

const asError = (error: PlatformError | ScheduleError): ScheduleError => error instanceof ScheduleError
  ? error : blocked("Cannot safely access schedule files or user systemd.");

const ntfyNotice = "If you enable ntfy notifications, a run can send job titles and employers with a dashboard link, or a failure notice, through ntfy.sh.";

const invalidTarget = () => blocked("Invalid installation root or profile ID.");
const invalidRender = () => blocked("Cannot render schedule. Check the command and period.");

export const ScheduleLive = Layer.effect(Schedule, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executor = yield* CommandExecutor.CommandExecutor;

  const safeDirectory = (raw: string | undefined) => Effect.gen(function* () {
    if (raw === undefined || !isAbsolute(raw)) return yield* blocked("The user unit directory must be absolute");

    const directory = yield* physicalPath(raw).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(() => blocked("Cannot resolve the user unit directory")),
    );

    if (["/etc/systemd", "/usr", "/lib", "/run/systemd/system"].some((base) => directory === base || directory.startsWith(`${base}/`))) {
      return yield* blocked("System-wide unit directories are forbidden");
    }

    return directory;
  });

  const target = (input: ScheduleTarget) => Effect.gen(function* () {
    const directory = yield* safeDirectory(input.unitDir);
    const root = yield* fs.realPath(input.root);
    const names = yield* Effect.try({ try: () => unitNames(root, input.profileId), catch: invalidTarget });

    return { root, directory, names, paths: names.map((name) => join(directory, name)) };
  });

  const systemctl = (...args: string[]) => Effect.scoped(Effect.gen(function* () {
    const command = Command.make("systemctl", "--user", ...args).pipe(
      Command.env({ LC_ALL: "C", SYSTEMD_COLORS: "0" }), Command.stdout("pipe"), Command.stderr("pipe"),
    );

    const process = yield* executor.start(command);

    const [code, output] = yield* Effect.all([
      process.exitCode,
      process.stdout.pipe(Stream.decodeText(), Stream.mkString),
      process.stderr.pipe(Stream.runDrain),
    ], { concurrency: "unbounded" });

    if (code !== 0) return yield* blocked("User systemd command failed. Use manual pulse commands instead; do not use sudo.");

    return output;
  })).pipe(Effect.timeoutFail({ duration: "30 seconds", onTimeout: () => blocked("User systemd command timed out") }));

  const atomicWrite = (directory: string, path: string, text: string) => Effect.scoped(Effect.gen(function* () {
    const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".pulse-" });
    yield* fs.chmod(temporary, 0o644);
    yield* fs.writeFileString(temporary, text);
    yield* Effect.scoped(Effect.gen(function* () {
      const file = yield* fs.open(temporary, { flag: "r+" });
      yield* file.sync;
    }));
    yield* fs.link(temporary, path);
  }));

  return {
    install: (input) => Effect.gen(function* () {
      const { root, directory, names, paths } = yield* target(input);
      const render = { period: input.period, resolvedRoot: root, profileId: input.profileId, command: input.command, searchPath: input.searchPath };
      const units = yield* Effect.try({ try: () => renderUnits(render), catch: invalidRender });

      for (const path of paths) {
        if (yield* fs.exists(path)) return yield* blocked("Units already exist. Remove this installation's timer first.");
      }

      if (!(yield* input.available)) return yield* blocked("run-scheduled is not available yet. Use pulse refresh manually.");

      if (!(yield* input.ready)) return yield* blocked("Schedule needs a ready profile and working model tools. See pulse status.");
      yield* systemctl("show-environment");
      yield* input.io.say(yield* Effect.try({ try: () => showSchedule(render, input.after), catch: invalidRender }));
      yield* input.io.say(`Two files are written to ${directory}. The timer is enabled for your user. Each run will:\nTake the installation lock.\nRefresh source data, locations and configured model reviews.\nCapture the snapshot.\nUpload only a completed snapshot and only if configured; upload nothing on pipeline failure.\nRecord the run result.\n${ntfyNotice}`);

      if ((yield* input.io.ask("Type yes to install and enable this timer:")).trim() !== "yes") {
        yield* input.io.say("Nothing was installed.");

        return false;
      }

      const written: string[] = [];
      let enableAttempted = false;
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });

        for (const [name, text] of Object.entries(units)) {
          const path = join(directory, name);
          yield* Effect.uninterruptible(Effect.gen(function* () {
            yield* atomicWrite(directory, path, text);
            written.push(path);
          }));
        }

        yield* systemctl("daemon-reload");
        enableAttempted = true;
        yield* systemctl("enable", "--now", names[1]);
      }).pipe(Effect.onError(() => Effect.gen(function* () {
        if (enableAttempted) yield* systemctl("disable", "--now", names[1]).pipe(
          Effect.catchAll(() => input.io.say("Rollback could not disable the timer. Check user systemd manually.")),
        );

        for (const path of written) yield* fs.remove(path, { force: true }).pipe(
          Effect.catchAll(() => input.io.say("Rollback could not remove a unit. Check user systemd manually.")),
        );
        yield* systemctl("daemon-reload").pipe(Effect.catchAll(() => input.io.say("Rollback reload failed. Check user systemd manually.")));
      }).pipe(Effect.ignore)));
      yield* input.io.say("Timer installed and enabled.");

      return true;
    }).pipe(Effect.mapError(asError), Effect.catchAll((error) => input.io.say(`Schedule blocked: ${error.message}`).pipe(Effect.as(false)))),
    remove: (input) => Effect.gen(function* () {
      const { directory, names, paths } = yield* target(input);

      const present = yield* Effect.forEach(paths, fs.exists);

      if (!present.some(Boolean)) {
        yield* input.io.say("Nothing is installed.");

        return true;
      }

      yield* input.io.say(`Disable and stop ${names[1]}, delete only ${names[0]} and ${names[1]} from ${directory}, then reload user systemd.`);

      if ((yield* input.io.ask("Type yes to remove this timer:")).trim() !== "yes") {
        yield* input.io.say("Nothing was removed.");

        return false;
      }

      yield* systemctl("disable", "--now", names[1]);

      for (const path of paths) yield* fs.remove(path, { force: true });

      yield* systemctl("daemon-reload");
      yield* input.io.say("Timer removed.");

      return true;
    }).pipe(Effect.mapError(asError), Effect.catchAll((error) => input.io.say(`Removal blocked: ${error.message}. Check the user timer before retrying.`).pipe(Effect.as(false)))),
    runNow: (input) => Effect.gen(function* () {
      const { names, paths } = yield* target(input);
      const present = yield* Effect.forEach(paths, fs.exists);

      if (!present.every(Boolean)) return yield* blocked("This profile's timer is not installed.");
      yield* input.io.say(`Start ${names[0]}. This may refresh live data, use models and upload a snapshot. Interval schedules still check if today is due.\n${ntfyNotice}`);

      if ((yield* input.io.ask("Type yes to start the timer service:")).trim() !== "yes") return false;
      yield* systemctl("start", "--no-block", names[0]);
      yield* input.io.say("Service start requested. This does not confirm a refresh completed.");

      return true;
    }).pipe(Effect.mapError(asError), Effect.catchAll((error) => input.io.say(`Run blocked: ${error.message}`).pipe(Effect.as(false)))),
    status: (input) => Effect.gen(function* () {
      const { names, paths } = yield* target(input);

      const present = yield* Effect.forEach(paths, (path) => Effect.gen(function* () {
        return yield* fs.stat(path).pipe(Effect.map((info) => info.type === "File"),
          Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error)));
      }));

      const result = { installed: present.every(Boolean), partial: present.some(Boolean) && !present.every(Boolean) };

      if (!present.some(Boolean)) return result;

      return yield* systemctl("list-timers", names[1], "--no-pager").pipe(Effect.map((output) => {
        const stamp = "(?:[A-Za-z]{3} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} \\S+|n/a)";
        const pattern = new RegExp(`^\\s*(${stamp})\\s+.+?\\s+(${stamp})\\s+.+?\\s+${names[1].replaceAll(".", "\\.")}(?:\\s|$)`);

        for (const row of output.split("\n")) {
          const match = pattern.exec(row);

          if (match) return { ...result, next: match[1] ?? "unknown", last: match[2] ?? "unknown" };
        }

        return { ...result, next: "unknown", last: "unknown" };
      }), Effect.catchAll(() => Effect.succeed({ ...result, error: "User systemd is unavailable; timer runtime is unknown." })));
    }).pipe(Effect.mapError(asError)),
  };
}));
