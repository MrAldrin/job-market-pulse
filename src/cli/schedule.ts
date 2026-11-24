import { Command } from "@effect/cli";
import { FileSystem, Terminal } from "@effect/platform";
import { Clock, Config, Console, Effect, Option } from "effect";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessExecutables } from "../lib/server/judge/reviewer-detect.ts";
import { rejudgeOptions, rejudgeReviewer } from "../lib/server/judge/reviewers.ts";
import { checkPipelineHarnessPlatform, macPiUnavailable } from "../lib/server/orchestration/pipeline-review.ts";
import { launchdArguments } from "../lib/server/orchestration/schedule-launchd-render.ts";
import { diagnoseWindowsFailure } from "../lib/server/orchestration/windows-failure-report.ts";
import { verifyWindowsWritableSqlite } from "../lib/server/shared/windows-private-files.ts";
import { Schedule, ScheduleError, type SchedulePrompt } from "../lib/server/orchestration/schedule.ts";
import { userUnitDirectory } from "../lib/server/orchestration/schedule-environment.ts";
import { profilePeriod } from "../lib/server/orchestration/schedule-profile.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { Profile } from "../lib/server/profile/service.ts";
import { installedPaths, isCompiledPulse } from "../lib/server/shared/installation-paths.ts";
import { readProfileModels } from "./profile-check.ts";
import { refreshPublishSettings } from "./pulse-publish.ts";

export interface ScheduleSelection {
  readonly root: Option.Option<string>;
  readonly profile: Option.Option<string>;
}

export const terminalSchedulePrompt = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;

  return {
    say: (text) => Console.log(text),
    ask: (text) => Console.log(text).pipe(
      Effect.zipRight(terminal.readLine),
      Effect.mapError(() => new ScheduleError({ message: "Cannot read timer confirmation" })),
    ),
  } satisfies SchedulePrompt;
});

export const explicitScheduleTarget = <R>(selection: Effect.Effect<ScheduleSelection, never, R>) => Effect.gen(function* () {
  const value = yield* selection;

  if (Option.isNone(value.root) || Option.isNone(value.profile)) {
    return yield* new ScheduleError({ message: "Schedule commands require explicit --root and --profile." });
  }

  const files = yield* ProfileFiles;
  const root = yield* files.root(value.root.value);

  return { root, profileId: value.profile.value };
});

export const windowsScheduleLauncher = (compiled: boolean, executable: string, checkoutEntry: () => string) =>
  compiled ? [executable] : [executable, "--no-env-file", checkoutEntry()];

const checkoutEntry = () => fileURLToPath(new URL("./pulse.ts", import.meta.url));

const scheduleSearchPath = (windows: boolean) => Config.string("PATH").pipe(
  Config.withDefault(""),
  Effect.map((path) => windows || path === "" ? path : path.split(delimiter).map((part) => resolve(part)).join(delimiter)),
);

const taskArgs = ({ root, profileId }: { readonly root: string; readonly profileId: string }) =>
  ["--root", root, "--profile", profileId, "run-scheduled"];

export const scheduleCommands = <R, R2>(selection: Effect.Effect<ScheduleSelection, never, R>, prompt: Effect.Effect<SchedulePrompt, never, R2>, which: (name: string, searchPath: string) => string | null) => {
  const windows = process.platform === "win32";
  const windowsCompiled = windows && isCompiledPulse;

  const selected = Effect.gen(function* () {
    const target = yield* explicitScheduleTarget(selection);

    return windows
      ? { ...target, command: [...windowsScheduleLauncher(windowsCompiled, process.execPath, checkoutEntry), ...taskArgs(target)] }
      : process.platform === "darwin" ? target : { ...target, unitDir: yield* userUnitDirectory };
  });

  const install = Command.make("install", {}, () => Effect.gen(function* () {
    // An installed Linux binary can run from a transient AppImage mount.
    if (!windows && installedPaths !== null) return yield* new ScheduleError({ message: "Timer installation requires a checkout." });
    const target = yield* selected;
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    const period = yield* profilePeriod(target.root, target.profileId, { now, requireAnchor: true });
    const profiles = yield* Profile;
    const fs = yield* FileSystem.FileSystem;
    const files = yield* ProfileFiles;
    const command = "command" in target ? target.command : [process.execPath, checkoutEntry(), ...taskArgs(target)];
    const launcherFile = command[windows ? windowsCompiled ? 0 : 2 : 1]!;
    const schedule = yield* Schedule;
    const searchPath = yield* scheduleSearchPath(windows);

    if (process.platform === "darwin") {
      const models = yield* readProfileModels(target.root);

      if (models !== null) yield* checkPipelineHarnessPlatform(models, "darwin", true).pipe(
        Effect.mapError(() => new ScheduleError({ message: macPiUnavailable })),
      );
    }

    const ready = Effect.gen(function* () {
      const loaded = yield* profiles.load(target.root, target.profileId);
      const models = yield* readProfileModels(target.root);

      if (models === null || searchPath === "") return false;

      const upload = yield* refreshPublishSettings(target.root, target.profileId, true).pipe(
        Effect.tapError((error) => Console.error(error.message)),
      );

      if (upload !== null && which(windows ? "railway.exe" : "railway", searchPath) === null) {
        yield* Console.error("Upload is configured but the Railway CLI is not on the timer's PATH.");

        return false;
      }

      if (windows) {
        const reviewers = [models.screen, models.judge];

        if (rejudgeOptions(models).levels.length > 0) reviewers.push(rejudgeReviewer(models));

        if (reviewers.some((reviewer) => reviewer.harness === "pi") || which("claude.exe", searchPath) === null) return false;

        yield* verifyWindowsWritableSqlite(loaded.bundle.paths.directory, loaded.bundle.paths.review_db);

        return true;
      }

      const tools = new Set([harnessExecutables[models.screen.harness], harnessExecutables[models.judge.harness]]);

      return [...tools].every((tool) => which(tool, searchPath) !== null);
    }).pipe(Effect.provideService(ProfileFiles, files), Effect.provideService(FileSystem.FileSystem, fs), Effect.orElseSucceed(() => false));

    const installed = yield* schedule.install({
      ...target, period, searchPath, after: now, io: yield* prompt,
      command,
      available: fs.exists(launcherFile).pipe(Effect.orElseSucceed(() => false)), ready,
    });

    if (!installed) return yield* new ScheduleError({ message: "Timer installation was not completed." });
  }).pipe(diagnoseWindowsFailure("schedule", "schedule-install", () => null)));

  const status = Command.make("status", {}, () => Effect.gen(function* () {
    const target = yield* selected;
    const schedule = yield* Schedule;
    const result = yield* schedule.status(target);

    yield* Console.log(`installed: ${result.installed ? "True" : "False"}`);
    yield* Console.log(`partial: ${result.partial ? "True" : "False"}`);

    if (result.next !== undefined) yield* Console.log(`next: ${result.next}`);

    if (result.last !== undefined) yield* Console.log(`last: ${result.last}`);

    if (result.error !== undefined) yield* Console.log(`error: ${result.error}`);
  }).pipe(diagnoseWindowsFailure("schedule", "schedule-status", () => null)));

  const remove = Command.make("remove", {}, () => Effect.gen(function* () {
    const target = yield* selected;
    const schedule = yield* Schedule;
    const io = yield* prompt;

    if (!(yield* schedule.remove({ ...target, io }))) return yield* new ScheduleError({ message: "Timer removal was not completed" });
  }).pipe(diagnoseWindowsFailure("schedule", "schedule-remove", () => null)));

  const runNow = Command.make("run-now", {}, () => Effect.gen(function* () {
    const target = yield* selected;
    const schedule = yield* Schedule;
    const io = yield* prompt;

    const action = yield* Effect.gen(function* () {
      if (process.platform !== "darwin") return target;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const period = yield* profilePeriod(target.root, target.profileId, { now, requireAnchor: true });

      const command = yield* Effect.try({
        try: () => launchdArguments([process.execPath, checkoutEntry(), ...taskArgs(target)], period),
        catch: () => new ScheduleError({ message: "Cannot reconstruct the expected LaunchAgent action." }),
      });

      const searchPath = yield* scheduleSearchPath(false);

      return { ...target, command, searchPath };
    });

    if (!(yield* schedule.runNow({ ...action, io }))) return yield* new ScheduleError({ message: "Immediate run was not requested." });
  }).pipe(diagnoseWindowsFailure("schedule", "schedule-run-now", () => null)));

  return Command.make("schedule", {}, () => Effect.fail(new ScheduleError({ message: "Use schedule install, status, remove or run-now." }))).pipe(Command.withSubcommands([install, status, remove, runNow]));
};
