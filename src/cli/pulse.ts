#!/usr/bin/env bun
import { CliConfig, Command, CommandDescriptor, CommandDirective, HelpDoc, Options, Usage } from "@effect/cli";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, HashMap, HashSet, Layer, Match, Option } from "effect";
import { fileURLToPath } from "node:url";
import packageInfo from "../../package.json" with { type: "json" };
import { DashboardLauncherLive } from "../lib/server/dashboard/launcher.ts";
import { alertScheduledFailure, prepareTopJobsAlert } from "../lib/server/orchestration/ntfy-notifications.ts";
import { runScheduled } from "../lib/server/orchestration/run-scheduled.ts";
import { diagnoseWindowsFailure, type WindowsFailureStage } from "../lib/server/orchestration/windows-failure-report.ts";
import { installedPaths } from "../lib/server/shared/installation-paths.ts";
import { parentPipeKey, watchParentPipe } from "../lib/server/shared/parent-pipe.ts";
import { PipelineLive } from "../lib/server/runtime.ts";
import { checkoutText } from "./checkout-options.ts";
import { checkoutStatus, withSelected, type CheckoutHost, type CheckoutReport } from "./checkout-reports.ts";
import { dashboard as launchDashboard, demo as launchDemo } from "./dashboard.ts";
import { nativeDesktopLauncher, type DesktopLauncher } from "./desktop-launcher.ts";
import { desktop as launchDesktop } from "./desktop.ts";
import { checkoutDoctor } from "./doctor.ts";
import { nativeDoctorHost, type DoctorHost } from "./doctor-host.ts";
import { checkoutInit } from "./init-checkout-host.ts";
import { initCommand, type CheckoutInitRunner } from "./init-command.ts";
import { publish } from "./pulse-publish.ts";
import { CheckoutRefresh, CheckoutRefreshLive } from "./pulse-refresh.ts";
import { explicitScheduleTarget, scheduleCommands, terminalSchedulePrompt } from "./schedule.ts";
import { sqliteBackup } from "./sqlite-backup.ts";

const checkoutCliConfig = CliConfig.make({ isCaseSensitive: true, showBuiltIns: false, autoCorrectLimit: 0 });
const frameworkOnly = /^--(?:no-)?(?:wizard|completions|log-level)(?=$|=)/iu;

const lossyEquals = (arg: string): boolean => {
  const trimmed = arg.trim();

  // Effect trims before splitting --option=value. Never dispatch to a path
  // that differs from the requested bytes. Separate value tokens stay intact.
  return trimmed !== arg && /^--[^=]+=/u.test(trimmed);
};

const optionNames = (usage: Usage.Usage, withValue: boolean): readonly string[] => Match.value(usage).pipe(Match.tagsExhaustive({
  Named: ({ names, acceptedValues }) => Option.isSome(acceptedValues) === withValue ? names.filter((name) => name.startsWith("-")) : [],
  Optional: ({ usage }) => optionNames(usage, withValue),
  Repeated: ({ usage }) => optionNames(usage, withValue),
  Concat: ({ left, right }) => [...optionNames(left, withValue), ...optionNames(right, withValue)],
  Alternation: ({ left, right }) => [...optionNames(left, withValue), ...optionNames(right, withValue)],
  Empty: () => [],
  Mixed: () => [],
}));

const subcommand = (descriptor: CommandDescriptor.Command<unknown>, name: string) =>
  HashSet.has(CommandDescriptor.getNames(descriptor), name) ? undefined : Option.getOrUndefined(HashMap.get(CommandDescriptor.getSubcommands(descriptor), name));

// Check only option tokens. Value-taking options in the selected descriptor
// consume their next raw token unchanged. Effect still validates all values.
const hasInvalidFlag = (descriptor: CommandDescriptor.Command<unknown>, args: readonly string[]) => {
  let scope = descriptor;
  let index = 1;

  for (; index < args.length; index++) {
    const child = subcommand(scope, args[index]!);

    if (child === undefined) break;
    scope = child;
  }

  const usage = CommandDescriptor.getUsage(scope);
  const takesValue = new Set(optionNames(usage, true));
  const bareFlags = new Set(optionNames(usage, false));

  for (; index < args.length; index++) {
    const arg = args[index]!;
    const name = CliConfig.normalizeCase(checkoutCliConfig, arg);
    const equals = name.indexOf("=");
    const next = args[index + 1];

    if (lossyEquals(arg)) return true;

    // Effect also accepts values on booleans. Retained switches are valueless
    // and no route with these switches takes positional operands.
    if (equals >= 0 ? bareFlags.has(name.slice(0, equals)) : bareFlags.has(name) && next !== undefined && !next.startsWith("-")) return true;

    if (takesValue.has(name)) index++;
  }

  return false;
};

const decodeCommand = <A>(descriptor: CommandDescriptor.Command<A>, args: readonly string[]) => {
  if (hasInvalidFlag(descriptor, args)) return Effect.succeed(Option.none<A>());

  return CommandDescriptor.parse(descriptor, args, checkoutCliConfig).pipe(Effect.match({
    onFailure: () => Option.none(),
    onSuccess: (directive) => CommandDirective.isUserDefined(directive) && directive.leftover.length === 0 ? Option.some(directive.value) : Option.none(),
  }));
};

const selectorPrefixLength = (args: readonly string[], names: ReadonlySet<string>) => {
  let size = 0;

  while (size < args.length) {
    const arg = args[size]!;
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);

    if (!names.has(CliConfig.normalizeCase(checkoutCliConfig, name))) break;
    size += equals < 0 ? 2 : 1;
  }

  return size;
};

const checkoutHelp = (command: CommandDescriptor.Command<unknown>, parents: readonly string[]): string => {
  const commandUsage = CommandDescriptor.getUsage(command);
  const usage = parents.length ? Usage.concat(Usage.named([parents.join(" ")], Option.none()), commandUsage) : commandUsage;

  return HelpDoc.toAnsiText(HelpDoc.blocks([
    HelpDoc.h1("Job Market Pulse"), HelpDoc.p(`Job Market Pulse ${packageInfo.version}`), HelpDoc.h1("USAGE"),
    ...Usage.enumerate(usage, checkoutCliConfig).map(HelpDoc.p), CommandDescriptor.getHelp(command, checkoutCliConfig),
    HelpDoc.p("Put -h, --help or --version after the command name, without command options."),
  ])) + "\n";
};

// Help and version accept only a declared route after optional root selectors.
// Effect's built-in directive drops leftover arguments, so do not use it here.
function* metadataRoutes(args: readonly string[], verbs: readonly CommandDescriptor.Command<unknown>[]) {
  for (const [first, name] of args.entries()) {
    let target = verbs.find((verb) => HashSet.has(CommandDescriptor.getNames(verb), name));

    if (target === undefined) continue;

    for (let index = first + 1; index < args.length; index++) {
      const part = args[index];

      target = part === undefined || target === undefined ? undefined : subcommand(target, part);
    }

    if (target !== undefined) yield { prefix: args.slice(0, first), target, parents: ["pulse", ...args.slice(first, -1)] };
  }
}

export const makeCheckoutCli = <RInit = never>(host: CheckoutHost & { readonly doctor?: DoctorHost; readonly desktopLauncher?: DesktopLauncher }, emit: (report: CheckoutReport) => Effect.Effect<void>, runInit?: CheckoutInitRunner<RInit>) => {
  const missingCommand = (hint: string) => () => emit({ stdout: "", stderr: hint + "\n", exitStatus: 2 });
  const refuse = missingCommand("Invalid command or options. See pulse --help.");

  const selectors = {
    root: checkoutText("root").pipe(Options.withDescription("Installation root; defaults to the checkout or installed data directory"), Options.optional),
    profile: checkoutText("profile").pipe(Options.withDescription("Profile ID; selected reports otherwise use local_only/pulse.toml"), Options.optional),
  };

  const root = Command.make("pulse", selectors, missingCommand("A command is required. See pulse --help."));
  const selectorNames = new Set(optionNames(CommandDescriptor.getUsage(root.descriptor), true));

  const child = <Name extends string, R, E, A>(verb: Command.Command<Name, R, E, A>) => ({
    verb,
    dispatch: (args: readonly string[]) => decodeCommand(verb.descriptor, args).pipe(Effect.flatMap((value) =>
      Option.isSome(value) ? verb.transform(verb.handler(value.value), value.value) : refuse())),
  });

  const selection = root.pipe(Effect.map((options) => ({
    root: Option.getOrElse(options.root, () => host.defaultRoot), explicit: Option.getOrUndefined(options.profile),
  })));

  const report = <R>(read: (selected: Effect.Effect.Success<typeof selection>) => Effect.Effect<CheckoutReport, never, R>) =>
    () => selection.pipe(Effect.flatMap(read), Effect.flatMap(emit));

  const status = Command.make("status", {}, report(checkoutStatus)).pipe(Command.withDescription("Show local setup, last run and snapshot evidence"));

  const doctorHost = host.doctor ?? nativeDoctorHost(host.which);
  const launcher = doctorHost.platform === "linux" ? host.desktopLauncher ?? nativeDesktopLauncher(process.platform, host.which) : undefined;

  const doctor = Command.make("doctor", { json: Options.boolean("json") }, ({ json }) =>
    report((selected) => checkoutDoctor(selected, doctorHost, json, launcher))())
    .pipe(Command.withDescription("Check local setup requirements without starting a run"));

  const port = Options.integer("port").pipe(Options.withDefault(8770));

  const dashboard = Command.make("dashboard", {
    port, snapshot: checkoutText("snapshot").pipe(Options.optional), readOnly: Options.boolean("read-only"),
    serveOrigin: checkoutText("serve-origin").pipe(Options.withDescription("Exact HTTPS ts.net origin for private Tailscale Serve"), Options.optional),
    serveOwner: checkoutText("serve-owner").pipe(Options.withDescription("Exact Tailscale owner login, required with --serve-origin"), Options.optional),
  }, (options) => report((selected) => launchDashboard(selected, options.port, Option.getOrNull(options.snapshot), options.readOnly,
    Option.getOrNull(options.serveOrigin), Option.getOrNull(options.serveOwner)))());

  const launcherCommand = (name: string, install: boolean) => Command.make(name, {}, () =>
    (launcher?.change(install) ?? Effect.succeed({ stdout: "", stderr: "Menu launcher setup is only available from a Linux checkout.\n", exitStatus: 1 })).pipe(Effect.flatMap(emit)))
    .pipe(Command.withDescription(install ? "Add Job Market Pulse to the Linux app menu" : "Remove Job Market Pulse from the Linux app menu"));

  const desktop = Command.make("desktop", {
    snapshot: checkoutText("snapshot").pipe(Options.optional), readOnly: Options.boolean("read-only"),
  }, (options) => report((selected) => launchDesktop(selected, options.snapshot, options.readOnly))())
    .pipe(Command.withDescription("Open the local dashboard in a Linux desktop window"), Command.withSubcommands([
      launcherCommand("install-launcher", true), launcherCommand("remove-launcher", false),
    ]));

  const demo = Command.make("demo", { port }, (options) => launchDemo(options.port).pipe(Effect.flatMap(emit)));
  const railway = () => host.which(process.platform === "win32" ? "railway.exe" : "railway");
  const exitReport = (exitStatus: number) => ({ stdout: "", stderr: "", exitStatus });

  const completionReporter = () => {
    let committed: CheckoutReport | undefined;

    const report = (result: CheckoutReport) => Effect.suspend(() => {
      if (committed !== undefined) return Effect.void;
      committed = result;

      return emit(result);
    }).pipe(Effect.uninterruptible);

    return { report, committed: () => committed };
  };

  const refreshCommand = Command.make("refresh", {
    noPublish: Options.boolean("no-publish"), noNotify: Options.boolean("no-notify"), once: Options.boolean("once"), reset: Options.boolean("reset"),
    volume: checkoutText("volume").pipe(Options.optional),
  }, (options) => Effect.suspend(() => {
    const reporter = completionReporter();
    let stage: WindowsFailureStage = "preflight";

    return selection.pipe(Effect.flatMap((selected) => withSelected(selected, (root, id) => Effect.flatMap(CheckoutRefresh, ({ run }) => run({
      root, id, railway, noPublish: options.noPublish, noNotify: options.noNotify, once: options.once, reset: options.reset,
      volume: Option.getOrUndefined(options.volume),
      reportCompleted: (outcome) => reporter.report(exitReport(outcome.exitCode)),
    })).pipe(Effect.map((outcome) => {
      stage = outcome.failedStage ?? stage;

      return exitReport(outcome.exitCode);
    })))), diagnoseWindowsFailure<CheckoutReport>("refresh", "runner", ({ exitStatus }) =>
      exitStatus === 0 ? null : { stage, exitCode: exitStatus }, { committed: reporter.committed }), Effect.flatMap(reporter.report));
  }));

  const rereviewCommand = Command.make("re-review", {
    all: Options.boolean("all"), listings: checkoutText("listings").pipe(Options.optional),
  }, ({ all, listings }) => {
    if (all === Option.isSome(listings)) return missingCommand("Use either --all or --listings ID[,ID...].")();
    const listing = Option.getOrElse(listings, () => "").split(",");

    return selection.pipe(Effect.flatMap((selected) => withSelected(selected, (root, id) => Effect.flatMap(CheckoutRefresh, ({ rereview }) =>
      (rereview === undefined ? Effect.succeed(2) : rereview(root, id, all ? true : listing)).pipe(Effect.map(exitReport))))),
    diagnoseWindowsFailure<CheckoutReport>("re-review", "review", ({ exitStatus }) => exitStatus === 0 ? null : { stage: "review", exitCode: exitStatus }), Effect.flatMap(emit));
  }).pipe(Command.withDescription("Review eligible jobs with older saved reviews and capture locally"));

  const publishCommand = Command.make("publish", {
    apply: Options.boolean("apply"), yes: Options.boolean("yes"), service: checkoutText("service").pipe(Options.optional),
    volume: checkoutText("volume").pipe(Options.optional),
  }, (options) => selection.pipe(Effect.flatMap((selected) => withSelected(selected, (root, id) => publish({
    root, id, railway, apply: options.apply, yes: options.yes, service: Option.getOrUndefined(options.service), volume: Option.getOrUndefined(options.volume),
  }).pipe(Effect.map(exitReport)))), Effect.flatMap(emit)));

  const schedule = scheduleCommands(root, terminalSchedulePrompt, host.which);

  const scheduled = Command.make("run-scheduled", {
    onlyIfDue: Options.boolean("only-if-due"), period: checkoutText("period").pipe(Options.optional), anchor: checkoutText("anchor").pipe(Options.optional),
  }, (options) => Effect.suspend(() => {
    const reporter = completionReporter();
    let failedStage: WindowsFailureStage = "schedule";

    const report = (code: number, historyUnavailable?: true) => reporter.report({
      ...exitReport(code), stderr: historyUnavailable ? "Cannot finish the scheduled run or save its history.\n" : "",
    });

    const attempt = Effect.gen(function* () {
      const selected = yield* explicitScheduleTarget(root);
      const { run } = yield* CheckoutRefresh;

      return yield* runScheduled({
        ...selected, onlyIfDue: options.onlyIfDue,
        ...Option.match(options.period, { onNone: () => ({}), onSome: (period) => ({ period }) }),
        ...Option.match(options.anchor, { onNone: () => ({}), onSome: (anchor) => ({ anchor }) }),
        onFailure: (stage) => Effect.sync(() => { failedStage = stage; }),
        prepareAlert: (root) => prepareTopJobsAlert(root, selected.profileId), alertFailure: alertScheduledFailure, reportResult: report,
        refresh: (root, lease) => run({ root, id: selected.profileId, railway, lease, scheduled: true }),
      }).pipe(Effect.catchAll(() => report(1, true).pipe(Effect.as(1))));
    });

    return attempt.pipe(Effect.map(exitReport), diagnoseWindowsFailure<CheckoutReport>("run-scheduled", "schedule", ({ exitStatus }) =>
      exitStatus === 0 ? null : { stage: failedStage, exitCode: exitStatus }, { committed: reporter.committed }), Effect.flatMap(reporter.report));
  }));

  const backup = Command.make("sqlite_backup", { db: checkoutText("db"), output: checkoutText("output") }, ({ db, output }) =>
    sqliteBackup(db, output).pipe(Effect.flatMap((path) => Console.log(`Backup created: ${path}`))));
  // Tests can supply a wizard binding without native input or lookup.

  const setup = runInit === undefined ? [] : [child(initCommand(root, host.defaultRoot, runInit, emit))];
  const routes = [child(doctor), child(status), child(dashboard), child(desktop), child(refreshCommand), child(publishCommand), child(schedule), child(scheduled), child(demo), child(backup), child(rereviewCommand), ...setup] as const;
  const command = root.pipe(Command.withSubcommands([routes[0].verb, ...routes.slice(1).map((route) => route.verb)]));

  const parseSelectors = (args: readonly string[]) => decodeCommand(root.descriptor, ["pulse", ...args]);
  const validSelectors = (args: readonly string[]) => parseSelectors(args).pipe(Effect.map(Option.isSome));

  const metadata = (args: readonly string[], index: number) => Effect.gen(function* () {
    if (index !== args.length - 1) return yield* refuse();
    const before = args.slice(0, index);

    const show = (target: CommandDescriptor.Command<unknown>, parents: readonly string[]) => emit({
      stdout: args[index] === "--version" ? packageInfo.version + "\n" : checkoutHelp(target, parents), stderr: "", exitStatus: 0,
    });

    for (const route of metadataRoutes(before, routes.map(({ verb }) => verb.descriptor))) {
      // A selector value can have the same spelling as a verb. Accept a route
      // only when the prefix parses fully as root selectors.
      if (yield* validSelectors(route.prefix)) return yield* show(route.target, route.parents);
    }

    if (!(yield* validSelectors(before))) return yield* refuse();

    return yield* show(command.descriptor, []);
  });

  type Run = ReturnType<(typeof routes)[number]["dispatch"]>;

  // Decode the root prefix and the selected command separately. A selector
  // value can be a verb name, and child leftovers must not become selectors.
  const operational = (args: readonly string[]) => Effect.gen(function* () {
    const boundary = selectorPrefixLength(args, selectorNames);
    const selected = yield* parseSelectors(args.slice(0, boundary));

    if (Option.isNone(selected)) return yield* refuse();
    const tail = args.slice(boundary);
    const name = tail[0];

    if (name === undefined) return yield* root.transform(root.handler(selected.value), selected.value);
    const route = routes.find(({ verb }) => HashSet.has(CommandDescriptor.getNames(verb.descriptor), name));

    if (route === undefined) return yield* refuse();

    // Effect allows parent options after a subcommand. Launcher changes take none.
    if (name === "desktop" && (tail[1] === "install-launcher" || tail[1] === "remove-launcher") && tail.length !== 2) return yield* refuse();
    const dispatch: Effect.Effect<void, Effect.Effect.Error<Run>, Effect.Effect.Context<Run>> = route.dispatch(tail);

    return yield* dispatch.pipe(Effect.provideService(root.tag, selected.value));
  });

  return (argv: readonly string[]) => {
    const args = argv.slice(2);

    // No command takes positional arguments.
    if (args.some((arg) => arg === "--" || frameworkOnly.test(arg))) return refuse();
    const index = args.findIndex((arg) => arg === "-h" || arg === "--help" || arg === "--version");

    return index >= 0 ? metadata(args, index) : operational(args);
  };
};

const main = () => {
  let exitCode: number | undefined;

  const emit = (report: CheckoutReport) => Effect.sync(() => {
    exitCode = report.exitStatus;

    if (report.stdout) process.stdout.write(report.stdout);

    if (report.stderr) process.stderr.write(report.stderr);
  });

  const run = makeCheckoutCli({
    defaultRoot: installedPaths?.data ?? fileURLToPath(new URL("../../", import.meta.url)),
    which: (name, searchPath) => searchPath === undefined ? Bun.which(name) : Bun.which(name, { PATH: searchPath }),
  }, emit, checkoutInit);

  const services = Layer.merge(CheckoutRefreshLive, DashboardLauncherLive).pipe(Layer.provideMerge(PipelineLive));

  const errorReport = (error: { readonly message: string }) => emit({ stdout: "", stderr: error.message + "\n", exitStatus: 1 });

  const command = run(process.argv);
  const parentClosed = Effect.async<void>((resume) => Effect.sync(watchParentPipe(process.stdin, () => resume(Effect.void))));

  const supervised = process.env[parentPipeKey] === "1"
    ? Effect.raceFirst(command, parentClosed.pipe(Effect.zipRight(Effect.interrupt))) : command;

  supervised.pipe(
    Effect.catchTags({
      ProfileError: errorReport, PeriodError: errorReport, PublishError: errorReport, BackupError: errorReport, ScheduleError: errorReport,
      WorkflowLockError: () => errorReport({ message: "The installation lock is busy or unavailable." }),
      ConfigError: () => errorReport({ message: "Cannot read the user timer configuration directory" }),
    }),
    Effect.provide(services),
    BunRuntime.runMain({
      disableErrorReporting: true,
      teardown: (exit, end) => end(Exit.isSuccess(exit) ? exitCode ?? 0 : Cause.isInterruptedOnly(exit.cause) ? exitCode ?? 130 : 2),
    }),
  );
};

if (import.meta.main) main();
