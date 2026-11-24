import { Effect, Either, Predicate } from "effect";
import type { TomlTable } from "smol-toml";
import { decodeModelSettings, type ModelSettings } from "../lib/server/judge/reviewers.ts";
import type { PostcodeAreaError } from "../lib/server/profile/errors.ts";
import { NarrativeResources } from "../lib/server/profile/narrative-service.ts";
import type { Question } from "../lib/server/profile/narrative.ts";
import type { OccupationBox } from "../lib/server/profile/occupation-catalog.ts";
import type { PostcodeArea } from "../lib/server/profile/postcode-area.ts";
import { caseFold } from "../lib/server/shared/text.ts";
import { setupDefaults } from "./init-defaults.ts";
import { chooseOccupations, editExclusions } from "./init-filters.ts";
import { chooseSetupArea } from "./init-geography.ts";
import { setupPlanLines, setupSummary } from "./init-output.ts";
import { planInitProfileMode, reviewInitPlan, type InitSplitEdits } from "./init-plan.ts";
import { chooseSetupProfile } from "./init-profile-choice.ts";
import { askInitText, initQuestions, type InitInputError, type InitMissingAnswer, type InitQuestions } from "./init-prompts.ts";
import { projectSetupRecovery, setupRecoveryFields, type ValidatedSectionInput } from "./init-recovery-answers.ts";
import { prepareInitInputs, saveInitCheckpoint, type InitInputRequest } from "./init-recovery.ts";
import { planSetupSchedule } from "./init-schedule.ts";
import { bindInitProfile, initError, initText, relativeInitPath } from "./init-state.ts";
import { validateRetainedInterviewFacts, type GuidedInterview, type InterviewCancelled, type InterviewFacts, type InterviewIO } from "./interview-session.ts";
import type { DesktopLauncher } from "./desktop-launcher.ts";
import { runInterviewStep, verifyInterviewBaseline, type InterviewFilePlan } from "./interview-step.ts";

const headlines = {
  profile: "Profile", reviewer: "AI settings", geography: "Area", occupations: "Job areas", exclusions: "Exclusions", interview: "Profile text", schedule: "Schedule",
};

const profileSteps = ["profile", "reviewer", "geography", "occupations", "exclusions", "interview", "schedule"] as const;
export const setupSteps = [...profileSteps, "alert"] as const;
const exclusions = ["excluded_title_terms", "excluded_employers", "excluded_title_terms_input", "excluded_employers_input"];
const isNamedMissing = Predicate.isTagged("InitMissingAnswer");
const isInterviewMissing = Predicate.isTagged("InterviewMissingAnswer");

type SetupStep = typeof profileSteps[number];

type WizardStepIssue = InitInputError | InitMissingAnswer | InterviewCancelled;

type Exit = 0 | 1 | 130;

export interface SetupWizardRequest extends InitInputRequest {
  readonly nonInteractive: boolean;
}

interface SetupWizardServices<R> {
  readonly osloDate: string;
  readonly lookupDate: string;
  readonly catalog: readonly OccupationBox[];
  readonly lookup: (postcode: string) => Effect.Effect<PostcodeArea, PostcodeAreaError, R>;
  readonly planModels: (ctx: InitQuestions, original: string | null) => Effect.Effect<string | undefined, WizardStepIssue, R>;
  readonly selectGuided: (models: ModelSettings | null) => Effect.Effect<GuidedInterview<R> | null, never, R>;
  readonly desktopLauncher?: DesktopLauncher | undefined;
  readonly readinessLines: (root: string, id: string) => Effect.Effect<readonly string[], InitInputError, R>;
  readonly monotonicSeconds?: (() => number) | undefined;
}

const confirm = (io: InterviewIO, prompt: string) => askInitText(io, {
  prompt, default: "no", validate: (value) => ["yes", "y", "no", "n"].includes(caseFold(value)) ? null : "Answer yes or no.",
}).pipe(Effect.map((value) => ["yes", "y"].includes(caseFold(value))));

export const offerDesktopLauncher = (io: InterviewIO, launcher: DesktopLauncher) => Effect.gen(function* () {
  if (yield* launcher.installed) return;
  yield* io.say("The menu entry needs Electron, a dashboard build and a saved snapshot for the selected profile.");
  yield* io.say("To try invented jobs first, run bun run build, then bun src/cli/pulse.ts demo from the checkout.");

  if (launcher.prepare) yield* io.say("This step downloads the pinned Electron runtime if it is not installed.");

  const prompt = "Add Job Market Pulse to the app menu? [y/N]";

  while (true) {
    const answer = yield* io.ask(prompt + " ").pipe(Effect.map((value) => caseFold(value.trim())));

    if (answer === "" || answer === "n" || answer === "no") return;

    if (answer === "y" || answer === "yes") {
      if (launcher.prepare && !(yield* launcher.prepare)) {
        yield* io.say("Could not set up Electron. The menu entry was not added. To retry, run bun run setup:desktop, then pulse desktop install-launcher.");

        return;
      }

      const result = yield* launcher.change(true);

      if (result.stdout) yield* io.say(result.stdout.trimEnd());

      if (result.stderr) yield* io.say(result.stderr.trimEnd());

      if (result.exitStatus !== 0) yield* io.say("To retry, run pulse desktop install-launcher.");

      return;
    }

    yield* io.say("Answer yes or no.");
  }
}).pipe(Effect.catchTag("InterviewCancelled", () => io.say("Desktop launcher setup skipped.")));

const setFacts = (answers: TomlTable, facts: InterviewFacts): void => {
  for (const [key, value] of Object.entries(facts)) {
    if (value === null) delete answers[key];
    else answers[key] = value;
  }
};

// The command entry point supplies owned model discovery, postcode lookup and
// readiness. This controller never registers a command or calls them by default.
export const runSetupWizard = <R>(request: SetupWizardRequest, io: InterviewIO, services: SetupWizardServices<R>) => Effect.gen(function* () {
  const prepared = yield* prepareInitInputs(request);
  let state = prepared.state;
  const modelSnapshot = state.files.models.original;
  const originalModels = modelSnapshot === null ? null : yield* initText(modelSnapshot);
  const defaults = yield* setupDefaults(state, services.catalog, services.osloDate);
  const answers: TomlTable = { ...defaults, ...prepared.answers };

  // A partial schedule deliberately omits the normalized period. Do not
  // restore the committed period if the user cancels another attempt.
  if (prepared.recoveredKeys.has("schedule_choice") && !prepared.recoveredKeys.has("schedule_normalized")) delete answers.schedule_normalized;

  const ctx = initQuestions(io, {
    answers, committedDefaults: defaults, explicitKeys: prepared.explicitKeys, recoveredKeys: prepared.recoveredKeys,
    nonInteractive: request.nonInteractive, advanced: request.advanced, recoveryStep: request.step ?? "all",
  });

  const selected = profileSteps.filter((name) => request.step === undefined
    ? name !== "exclusions" || request.advanced || exclusions.some(ctx.inputChanged)
    : request.step === name);

  if (!selected.length) return yield* initError("Unknown setup step.");

  let memoryNotice = false;
  let activeStep: SetupStep | undefined;
  const acceptedSectionInput: ValidatedSectionInput = {};
  let questions: readonly Question[] | undefined;
  const allowedRecoveryFields = setupRecoveryFields(services.catalog);
  let config: string | undefined;
  let models: string | undefined;
  let narrative: InterviewFilePlan | undefined;
  let split: InitSplitEdits | undefined;
  let profileStep = false;

  const saveCheckpoint = (phase: "step" | "interview" | "finished") => Effect.gen(function* () {
    if (request.dryRun) return "dry-run";

    const keys = Object.keys(answers);
    const factKeys = keys.filter((key) => key.startsWith("interview_") && key !== "interview_replacement" && key !== "interview_section" && !allowedRecoveryFields.has(key));

    if (factKeys.length && questions === undefined) questions = yield* (yield* NarrativeResources).questions();
    const facts = questions === undefined ? null : validateRetainedInterviewFacts(questions, answers, new Set(factKeys));
    const projected = projectSetupRecovery(answers, allowedRecoveryFields, facts ?? {}, acceptedSectionInput);

    return yield* saveInitCheckpoint(state, request, projected, phase);
  });

  const checkpointInterview = (facts: InterviewFacts) => Effect.gen(function* () {
    setFacts(answers, facts);
    answers.interview = "incomplete";
    const status = yield* saveCheckpoint("interview");

    if (status === "memory-only" && !memoryNotice) {
      memoryNotice = true;
      yield* io.say("Private recovery is not available yet. Interview answers stay in memory until setup can save them.");
    }
  });

  const collect = {
    profile: () => Effect.gen(function* () {
      const choice = yield* chooseSetupProfile(ctx, state.profile?.id, (id) => Effect.gen(function* () {
        state = yield* bindInitProfile(state, id);
      }));

      if (!state.profile) return yield* initError("Run the profile step first.");
      config = yield* planInitProfileMode(state.profile, choice.searchMode);
      profileStep = true;
    }),
    reviewer: () => Effect.gen(function* () {
      const planned = yield* services.planModels(ctx, originalModels);

      if (planned !== undefined) yield* Either.mapLeft(decodeModelSettings(planned), () => initError("Planned model settings are invalid."));
      models = planned;
    }),
    geography: () => Effect.gen(function* () {
      const area = yield* chooseSetupArea(ctx, { date: services.lookupDate, lookup: services.lookup });
      split = { ...split, ...area };
    }),
    occupations: () => Effect.gen(function* () {
      const categories = yield* chooseOccupations(ctx, services.catalog);
      split = { ...split, allowed_occupation_categories: categories };
    }),
    exclusions: () => Effect.gen(function* () {
      const excluded = yield* editExclusions(ctx);
      split = { ...split, ...excluded };
    }),
    interview: () => Effect.gen(function* () {
      const path = state.profile ? yield* relativeInitPath(state.root, state.profile.paths.narrative_file) : undefined;

      const currentModel = () => Effect.gen(function* () {
        const text = models ?? originalModels;
        const settings = text === null ? null : yield* decodeModelSettings(text);

        return yield* services.selectGuided(settings);
      }).pipe(Effect.orElseSucceed(() => null));

      const result = yield* runInterviewStep({
        root: state.root, profileId: state.profile?.id, narrativePath: path, io, answers,
        explicitKeys: ctx.explicitKeys, recoveredKeys: ctx.recoveredKeys,
        interactive: !request.nonInteractive, dryRun: request.dryRun,
        selectGuided: Effect.suspend(currentModel), checkpoint: checkpointInterview,
        recordMenuAnswer: (key, value) => Effect.sync(() => {
          answers[key] = value;

          if (key === "interview_section" || key === "interview_replacement") acceptedSectionInput[key] = value;
        }),
        monotonicSeconds: services.monotonicSeconds,
      });

      answers.interview = result.status;

      if (result.status === "planned") narrative = result.plan;
    }),
    schedule: () => Effect.gen(function* () {
      if (!state.profile) return yield* initError("Run the profile step first.");

      const result = yield* planSetupSchedule(io, ctx, {
        profileId: state.profile.id, configText: config ?? state.profile.configText,
        configExists: state.profile.exists, osloDate: services.osloDate,
        recordAccepted: (key, value) => Effect.sync(() => {
          // A partial edit has no complete normalized period. Keep the
          // accepted choices and let the resumed prompts finish the plan.
          if (key !== "schedule_confirm" && answers[key] !== value) delete answers.schedule_normalized;
          answers[key] = value;
        }),
      });

      const { schedule_anchor, ...updates } = result.recoveryAnswers;
      Object.assign(answers, updates);

      if (schedule_anchor === null) delete answers.schedule_anchor;
      else answers.schedule_anchor = schedule_anchor;

      if (result.kind === "planned") config = result.configText;
    }),
  };

  const perform = Effect.gen(function* () {
    yield* io.say("Set up Job Market Pulse.");
    yield* io.say("Your answers may be saved privately before the final save. Settings are saved only after confirmation.");
    yield* io.say("Postal-area lookup is automatic for a new postcode. Nothing is installed automatically.");
    const missing: string[] = [];
    const total = selected.length + 1;

    for (const [index, name] of selected.entries()) {
      activeStep = name;
      yield* io.say(`${index + 1}/${total}  ${headlines[name]}`);

      if (!state.profile && missing.includes("profile_id") && (name === "schedule" || (name === "interview" && !request.dryRun))) continue;
      const result = yield* Effect.either(Effect.gen(function* () { yield* collect[name](); }));

      if (Either.isLeft(result)) {
        const error = result.left;

        if (!isNamedMissing(error) && !isInterviewMissing(error)) return yield* error;
        missing.push(error.key);
        continue;
      }

      yield* saveCheckpoint("step");
    }

    activeStep = undefined;

    if (missing.length) {
      yield* io.say("Missing answers: " + missing.join(", "));

      return 1 satisfies Exit;
    }

    yield* io.say(`${total}/${total}  Summary`);

    const summary = yield* setupSummary({
      answers, configText: config ?? (state.profile?.exists ? state.profile.configText : undefined),
      originalNarrative: state.profile?.files.narrative.original ?? null, dryRun: request.dryRun,
    });

    yield* Effect.forEach(summary, io.say, { discard: true });

    const reviewed = yield* reviewInitPlan(state, { profileStep, config, models, narrative, split });
    yield* Effect.forEach(setupPlanLines(reviewed.entries, request.advanced), io.say, { discard: true });

    const status = yield* reviewed.apply({
      dryRun: request.dryRun, nonInteractive: request.nonInteractive,
      replace: (path) => io.say("Replacement changes an existing file. A private backup will be kept.").pipe(Effect.zipRight(confirm(io, `Replace ${path}?`))),
      save: () => Effect.gen(function* () {
        if (narrative !== undefined) yield* verifyInterviewBaseline(state.root, narrative, "before-confirmation");
        const answer = yield* confirm(io, "Save these settings?");

        if (answer && narrative !== undefined) yield* verifyInterviewBaseline(state.root, narrative, "after-confirmation");

        return answer;
      }),
    });

    if (status === "dry-run") {
      yield* io.say("Dry run. No files were written.");

      return 0 satisfies Exit;
    }

    if (status === "needs-terminal") {
      yield* io.say("Confirmation needs a terminal. Use --dry-run to check scripted answers.");

      return 1 satisfies Exit;
    }

    if (status === "declined") {
      yield* io.say("No planned files were written.");

      return 0 satisfies Exit;
    }

    yield* saveCheckpoint("finished");

    if (status === "unchanged" && reviewed.entries.length) yield* io.say("Plan unchanged. No planned files were written.");

    if (state.profile) {
      const lines = yield* services.readinessLines(state.root, state.profile.id);
      yield* Effect.forEach(lines, io.say, { discard: true });
    }

    if (request.step === undefined && !request.nonInteractive && services.desktopLauncher !== undefined) {
      yield* offerDesktopLauncher(io, services.desktopLauncher);
    }

    return 0 satisfies Exit;
  });

  return yield* perform.pipe(Effect.catchTag("InterviewCancelled", () => Effect.gen(function* () {
    const result = yield* Effect.either(saveCheckpoint(activeStep === "interview" ? "interview" : "step"));

    if (Either.isLeft(result)) yield* io.say("Stopped. Answers could not be saved. No planned files were written.");
    else if (request.dryRun) yield* io.say("Stopped. Dry run: no answers or files were saved.");
    else if (result.right === "memory-only") yield* io.say("Stopped. Interview answers were kept in memory only; no recovery file was created.");
    else if (state.profile) {
      const scope = request.step === undefined ? "" : ` --step ${request.step}`;
      const mode = request.advanced ? " --advanced" : "";
      yield* io.say(`Stopped. Your answers so far are saved. Use the same installation root and select profile ${state.profile.id}. Run the init command with --resume${scope}${mode}.`);
    } else yield* io.say("Stopped. No profile ID was saved. Run the init command again with the same installation root.");

    return 130 satisfies Exit;
  })));
}).pipe(Effect.catchAll((error) => io.say(error.message || "Setup could not continue safely. Check local file access.").pipe(Effect.as(1 satisfies Exit))));
