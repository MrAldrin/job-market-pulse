import { Command, Options } from "@effect/cli";
import { type FileSystem, Terminal } from "@effect/platform";
import { Clock, DateTime, Effect, Either, Option } from "effect";
import { homedir } from "node:os";
import { OSLO_ZONE } from "../lib/server/clock.ts";
import { InterviewTurn } from "../lib/server/judge/interview-turn.ts";
import { harnessExecutables, type Harness } from "../lib/server/judge/reviewer-detect.ts";
import type { ModelSettings } from "../lib/server/judge/reviewers.ts";
import type { ProfileFiles } from "../lib/server/profile/files.ts";
import { NarrativeResources } from "../lib/server/profile/narrative-service.ts";
import { PostcodeAreaTag } from "../lib/server/profile/postcode-area.ts";
import { expandProfileRoot } from "../lib/server/shared/paths.ts";
import type { DesktopLauncher } from "./desktop-launcher.ts";
import { planAlertSetup } from "./init-alerts.ts";
import { checkoutText } from "./checkout-options.ts";
import type { CheckoutReport } from "./checkout-reports.ts";
import { planSetupModels, type SetupModelServices } from "./init-models.ts";
import type { InitQuestions } from "./init-prompts.ts";
import { runSetupWizard, setupSteps, type SetupWizardRequest } from "./init-wizard.ts";
import { guidedInterview, InterviewCancelled, type InterviewIO } from "./interview-session.ts";
import { setupReadinessLines } from "./profile-check-output.ts";
import { collectProfileFindings } from "./profile-check.ts";
import type { ScheduleSelection } from "./schedule.ts";

export type CheckoutInitRunner<R> = (request: SetupWizardRequest) => Effect.Effect<number, never, R>;

export interface CheckoutInitHost<R> extends Pick<SetupModelServices<R>, "detect" | "query"> {
  readonly executable: (name: typeof harnessExecutables[Harness]) => Effect.Effect<string | null, never, R>;
  readonly desktopLauncher?: DesktopLauncher;
  readonly monotonicSeconds?: () => number;
}

export const initCommand = <R, R2>(parent: Effect.Effect<ScheduleSelection, never, R>, defaultRoot: string, run: CheckoutInitRunner<R2>, emit: (report: CheckoutReport) => Effect.Effect<void>) => Command.make("init", {
  root: checkoutText("root").pipe(Options.optional, Options.withDescription("Installation root; overrides the root before init")),
  resume: Options.boolean("resume").pipe(Options.withDescription("Resume matching incomplete private setup answers")),
  answers: checkoutText("answers").pipe(Options.optional, Options.withDescription("Explicit answers in a standalone TOML file")),
  nonInteractive: Options.boolean("non-interactive"),
  advanced: Options.boolean("advanced"),
  dryRun: Options.boolean("dry-run").pipe(Options.withDescription("Show the plan without saving files or answers")),
  step: Options.choice("step", setupSteps).pipe(Options.optional, Options.withDescription("Repeat one named setup step")),
}, (options) => Effect.gen(function* () {
  const selected = yield* parent;
  const answersPath = Option.getOrUndefined(options.answers);
  const profile = Option.getOrUndefined(selected.profile);

  const request = {
    root: Option.getOrElse(options.root, () => Option.getOrElse(selected.root, () => defaultRoot)),
    step: Option.getOrUndefined(options.step),
    advanced: options.advanced, dryRun: options.dryRun, resume: options.resume, nonInteractive: options.nonInteractive,
  };

  const withAnswers = answersPath === undefined ? request : { ...request, answersPath };
  const exitStatus = yield* run(profile === undefined ? withAnswers : { ...withAnswers, profile });

  yield* emit({ stdout: "", stderr: "", exitStatus });
})).pipe(Command.withDescription("Plan and confirm local installation setup"));

// This binding is selected only after the descriptor has successfully parsed.
// The checkout supplies the prompt and metadata capabilities explicitly.
export const runCheckoutInit = <R>(request: SetupWizardRequest, host: CheckoutInitHost<R>, readSecret?: (prompt: string) => typeof Terminal.Terminal.Service.readLine) => Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;

  const io: InterviewIO = {
    say: (text) => terminal.display(text + "\n").pipe(Effect.orDie),
    ask: (prompt) => terminal.display(prompt).pipe(
      Effect.zipRight(terminal.readLine), Effect.mapError(() => new InterviewCancelled({ message: "Setup cancelled." })),
    ),
  };

  if (request.step === "alert") {
    if (readSecret === undefined) return yield* io.say("A private terminal prompt is required for notification setup.").pipe(Effect.as(1));

    return yield* planAlertSetup(request, io, (prompt) => readSecret(prompt).pipe(
      Effect.ensuring(io.say("")),
      Effect.mapError(() => new InterviewCancelled({ message: "Setup cancelled." })),
    ));
  }

  const resources = yield* NarrativeResources;
  const catalog = yield* Effect.either(resources.catalog);

  if (Either.isLeft(catalog)) return yield* io.say("Cannot read the bundled occupation catalog.").pipe(Effect.as(1));
  const current = DateTime.unsafeMake(yield* Clock.currentTimeMillis);
  const postcode = yield* PostcodeAreaTag;
  let expanded = request;

  if (request.answersPath?.startsWith("~")) {
    const path = expandProfileRoot(request.answersPath, homedir());

    if (Either.isLeft(path)) return yield* io.say("Setup answers path is not supported. Use an expanded absolute path.").pipe(Effect.as(1));
    expanded = { ...request, answersPath: path.right };
  }

  const services = {
    catalog: catalog.right, lookup: postcode.lookup,
    osloDate: DateTime.formatIsoDate(DateTime.setZone(current, OSLO_ZONE)),
    lookupDate: DateTime.formatIsoDate(DateTime.setZone(current, DateTime.zoneMakeLocal())),
    planModels: (ctx: InitQuestions, original: string | null) => planSetupModels(ctx, io, original, { dryRun: request.dryRun, detect: host.detect, query: host.query }).pipe(
      Effect.map((planned) => planned ?? undefined),
    ),
    selectGuided: (models: ModelSettings | null) => models === null ? Effect.succeed(null) : host.executable(harnessExecutables[models.judge.harness]).pipe(
      Effect.map((executable) => guidedInterview(models.judge, executable)),
    ),
    readinessLines: (root: string, id: string) => collectProfileFindings(root, id).pipe(Effect.map(setupReadinessLines)),
  };

  return yield* runSetupWizard<R | ProfileFiles | InterviewTurn | FileSystem.FileSystem>(expanded, io,
    { ...services, desktopLauncher: host.desktopLauncher, monotonicSeconds: host.monotonicSeconds },
  );
});
