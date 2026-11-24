import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { isCanonicalPath } from "../shared/paths.ts";
import { launchdLabel, renderLaunchd } from "./schedule-launchd-render.ts";
import { Schedule, ScheduleError, type SchedulePrompt, type ScheduleTarget } from "./schedule.ts";

const blocked = (message: string) => new ScheduleError({ message });
const accessError = () => blocked("Cannot safely access the user LaunchAgents directory or launchd.");

const fieldMatches = (lines: readonly string[], name: string, value: string): boolean => {
  const prefix = `\t${name} = `;
  const values = lines.filter((line) => line.startsWith(prefix));

  return values.length === 1 && values[0] === prefix + value;
};

const validSearchPath = (path: string | undefined): path is string =>
  path !== undefined && path !== "" && !/\p{Cc}/u.test(path);

const matchesEnvironment = (lines: readonly string[], searchPath: string | undefined): boolean => {
  if (!validSearchPath(searchPath)) return false;

  // Compare only the job-defined block, not launchd's inherited or default environment.
  const headers = lines.flatMap((line, index) => /^environment\b/.test(line.trimStart()) ? [index] : []);
  const start = headers[0];

  return headers.length === 1 && start !== undefined && lines[start] === "\tenvironment = {"
    && lines[start + 1] === `\t\tPATH => ${searchPath}` && lines[start + 2] === "\t}";
};

// launchctl print is diagnostic output, not a stable API. Unknown layouts,
// ambiguous fields and changed actions fail closed.
const matchesAction = (output: string, path: string, root: string, argv: readonly string[], searchPath: string | undefined): boolean => {
  const program = argv[0];

  if (program === undefined || argv.some((arg) => /[\r\n\t]/.test(arg))) return false;
  const lines = output.split("\n");
  const key = "\targuments = ";
  const starts = lines.flatMap((line, index) => line.startsWith(key) ? [index] : []);
  const start = starts[0];

  return fieldMatches(lines, "path", path) && fieldMatches(lines, "program", program) && fieldMatches(lines, "working directory", root)
    && matchesEnvironment(lines, searchPath)
    && starts.length === 1 && start !== undefined && lines[start] === `${key}{`
    && argv.every((arg, index) => lines[start + index + 1] === `\t\t${arg}`) && lines[start + argv.length + 1] === "\t}";
};

const ntfyConsent = "If ntfy notifications are enabled, a run can send job titles and employer names and can include a dashboard link. A failed run can send a failure notice.";

export const makeLaunchdSchedule = (user: () => { readonly uid: number; readonly homedir: string }) => Layer.effect(Schedule, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executor = yield* CommandExecutor.CommandExecutor;

  const launchctl = (...args: string[]) => Effect.scoped(Effect.gen(function* () {
    const process = yield* executor.start(Command.make("/bin/launchctl", ...args).pipe(
      Command.env({ LC_ALL: "C" }), Command.stdout("pipe"), Command.stderr("pipe"),
    ));

    const capture = args[0] === "print" && args[1]?.split("/").length === 3;

    const [code, stdout, stderr] = yield* Effect.all([
      process.exitCode, capture ? process.stdout.pipe(Stream.decodeText(), Stream.mkString) : process.stdout.pipe(Stream.runDrain, Effect.as("")),
      process.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });

    return { ok: code === 0, stdout, stderr };
  })).pipe(Effect.mapError(accessError), Effect.timeoutFail({
    duration: "30 seconds", onTimeout: () => blocked("launchctl command timed out."),
  }));

  const requireCommand = (message: string, ...args: string[]) => launchctl(...args).pipe(
    Effect.flatMap(({ ok }) => ok ? Effect.void : Effect.fail(blocked(message))),
  );

  const target = (input: ScheduleTarget) => Effect.gen(function* () {
    const { uid, homedir } = yield* Effect.try({ try: user, catch: accessError });

    if (!Number.isSafeInteger(uid) || uid <= 0 || !isAbsolute(homedir)) return yield* blocked("Use a macOS graphical login without sudo.");
    const root = yield* fs.realPath(input.root);
    const label = yield* Effect.try({ try: () => launchdLabel(root, input.profileId), catch: () => blocked("Invalid installation root or profile ID.") });
    const directory = join(yield* fs.realPath(homedir), "Library", "LaunchAgents");
    const path = join(directory, `${label}.plist`);

    if (!(yield* isCanonicalPath(path))) return yield* blocked("Refusing a LaunchAgents path with symbolic links.");
    const domain = `gui/${uid}`;

    return { root, directory, path, domain, service: `${domain}/${label}` };
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const present = (path: string) => fs.stat(path).pipe(
    Effect.flatMap((info) => info.type === "File" ? Effect.succeed(true) : Effect.fail(blocked("Expected a regular LaunchAgent file."))),
    Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error)),
  );

  const registered = (domain: string, service: string) => Effect.gen(function* () {
    yield* requireCommand("Cannot reach the graphical login domain. Use a macOS graphical login without sudo.", "print", domain);

    const { ok, stdout, stderr } = yield* launchctl("print", service);
    const label = service.slice(domain.length + 1);
    const uid = domain.slice("gui/".length);

    if (ok) return stdout;

    if (stderr.trim() === `Could not find service "${label}" in domain for user gui: ${uid}`) return null;

    return yield* blocked("Cannot determine whether the LaunchAgent is loaded.");
  });

  const recheckPath = (path: string) => isCanonicalPath(path).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap((safe) => safe ? Effect.void : Effect.fail(blocked("The LaunchAgents path changed."))),
  );

  const changeResult = (io: SchedulePrompt) => Effect.catchAll((error: ScheduleError | { readonly _tag: string }) =>
    io.say(`Schedule blocked: ${error instanceof ScheduleError ? error.message : accessError().message}`).pipe(Effect.as(false)),
  );

  return {
    install: (input) => Effect.gen(function* () {
      const { root, directory, path, domain, service } = yield* target(input);

      if (!validSearchPath(input.searchPath)) return yield* blocked("The LaunchAgent needs a nonempty PATH without control characters.");

      const text = yield* Effect.try({
        try: () => renderLaunchd({ ...input, resolvedRoot: root }),
        catch: () => blocked("Cannot render the LaunchAgent. Check the command and period."),
      });

      if ((yield* present(path)) || (yield* registered(domain, service)) !== null) return yield* blocked("A LaunchAgent already exists. Inspect schedule status before replacing it.");

      if (!(yield* input.available)) return yield* blocked("run-scheduled is not available. Use manual Pulse commands instead.");

      if (!(yield* input.ready)) return yield* blocked("Schedule needs a ready profile and working model tools. See pulse status.");

      yield* input.io.say(`${path}\n${text}\nThis uses the Mac's local time. Runs can refresh live data, use models and upload a completed snapshot if configured. ${ntfyConsent}`);

      if ((yield* input.io.ask("Type yes to install and load this LaunchAgent:")).trim() !== "yes") return false;

      yield* Effect.scoped(Effect.gen(function* () {
        yield* recheckPath(path);
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".pulse-" });
        yield* fs.chmod(temporary, 0o600);
        yield* fs.writeFileString(temporary, text);
        yield* fs.link(temporary, path);
      }));
      // The file may already be registered if bootstrap timed out. Keep it for
      // explicit recovery instead of unlinking a potentially loaded job.
      yield* requireCommand("Could not load the LaunchAgent.", "bootstrap", domain, path).pipe(
        Effect.mapError(() => blocked("Load did not confirm success. The plist remains. Check schedule status and remove it before retrying or logging in again.")),
      );
      yield* input.io.say("LaunchAgent installed and loaded. No refresh result was verified.");

      return true;
    }).pipe(changeResult(input.io)),
    status: (input) => Effect.gen(function* () {
      const { path, domain, service } = yield* target(input);
      const file = yield* present(path);

      return yield* registered(domain, service).pipe(
        Effect.map((output) => {
          const loaded = output !== null;
          const matches = loaded && fieldMatches(output.split("\n"), "path", path);

          return { installed: file && matches, partial: (file || loaded) && !(file && matches) };
        }),
        Effect.catchAll(() => Effect.succeed({ installed: false, partial: file, error: "LaunchAgent registration is unknown; launchd did not confirm its state." })),
      );
    }).pipe(Effect.mapError((error) => error instanceof ScheduleError ? error : accessError())),
    remove: (input) => Effect.gen(function* () {
      const { path, domain, service } = yield* target(input);
      const file = yield* present(path);
      const loaded = yield* registered(domain, service);

      if (loaded !== null && (!file || !fieldMatches(loaded.split("\n"), "path", path))) {
        return yield* blocked("The loaded label does not match the expected plist. Inspect launchd before removal.");
      }

      if (!file) {
        yield* input.io.say("Nothing is installed.");

        return true;
      }

      yield* input.io.say(`Unload ${service} if loaded, then delete only ${path}.`);

      if ((yield* input.io.ask("Type yes to remove this LaunchAgent:")).trim() !== "yes") return false;
      yield* recheckPath(path);

      const current = yield* registered(domain, service);

      if (current !== null) {
        if (!fieldMatches(current.split("\n"), "path", path)) return yield* blocked("The loaded plist changed.");
        yield* requireCommand("Unload failed. The plist was not removed.", "bootout", service);
      }

      yield* fs.remove(path);
      yield* input.io.say("LaunchAgent removed.");

      return true;
    }).pipe(changeResult(input.io)),
    runNow: (input) => Effect.gen(function* () {
      const { root, path, domain, service } = yield* target(input);

      const verifyAction = Effect.gen(function* () {
        if (!(yield* present(path))) return yield* blocked("The expected LaunchAgent plist is missing.");
        const output = yield* registered(domain, service);

        if (output === null || input.command === undefined || !matchesAction(output, path, root, input.command, input.searchPath)) {
          return yield* blocked("Cannot verify the loaded Pulse action. Inspect schedule status; remove and reinstall if the action changed.");
        }
      });

      yield* verifyAction;
      yield* input.io.say(`Start ${service}. This can refresh live data, use models and upload a completed snapshot. ${ntfyConsent} Interval schedules still check if today is due.`);

      if ((yield* input.io.ask("Type yes to request a run:")).trim() !== "yes") return false;
      yield* recheckPath(path);
      yield* verifyAction;
      yield* requireCommand("LaunchAgent start failed.", "kickstart", service);
      yield* input.io.say("Start requested. This does not confirm a refresh completed.");

      return true;
    }).pipe(changeResult(input.io)),
  };
}));

export const LaunchdScheduleLive = makeLaunchdSchedule(userInfo);
