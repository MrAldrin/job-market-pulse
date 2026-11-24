import { Data, Effect, Either, Predicate } from "effect";
import { isAbsolute, join, relative, sep } from "node:path";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { NarrativeResources } from "../lib/server/profile/narrative-service.ts";
import { adjustableSections, checkNarrative, fillTemplate, hasMeaningfulContent, replaceSection, sectionHeadings, type Answers } from "../lib/server/profile/narrative.ts";
import { readBoundedFile } from "../lib/server/shared/bounded-file.ts";
import { sha256 } from "../lib/server/shared/python-json.ts";
import { caseFold } from "../lib/server/shared/text.ts";
import { BudgetedInterviewIO, InterviewCancelled, fitsInterviewText, maxInterviewAnswerBytes, maxInterviewContextBytes, runInterviewSession, stripInterviewAnswer, type GuidedInterview, type InterviewIO, type InterviewSessionOptions } from "./interview-session.ts";

export class InterviewPlanError extends Data.TaggedError("InterviewPlanError")<{ readonly message: string }> {}

type InterviewMenuKey = "interview_existing" | "interview_section" | "interview_replacement" | "interview_method";

export class InterviewMissingAnswer extends Data.TaggedError("InterviewMissingAnswer")<{ readonly key: InterviewMenuKey }> {}

export interface InterviewStepOptions<R, E, C> {
  /** Physical installation root resolved by the wizard. */
  readonly root: string;
  readonly profileId: string | undefined;
  /** Retained custom target, relative to root. */
  readonly narrativePath?: string | undefined;
  readonly io: InterviewIO;
  readonly answers: Answers;
  readonly explicitKeys: ReadonlySet<string>;
  readonly recoveredKeys: ReadonlySet<string>;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly selectGuided?: Effect.Effect<GuidedInterview<R> | null, never, R>;
  readonly monotonicSeconds?: (() => number) | undefined;
  readonly checkpoint?: InterviewSessionOptions<R, E, C>["checkpoint"];
  readonly recordMenuAnswer?: (key: InterviewMenuKey, value: string) => Effect.Effect<void, E, C>;
}

export interface InterviewFilePlan {
  readonly path: string;
  readonly content: string;
  readonly mode: 0o600;
  readonly overwrite: boolean;
  /** Internal only: never include this value in the printed plan. */
  readonly expectedDigest: string;
}

type InterviewStepResult = { readonly status: "planned"; readonly plan: InterviewFilePlan }
  | { readonly status: "kept" | "skipped" | "incomplete" | "later" };

const changedDuringInterview = "The profile text changed during the interview. Run setup again.";
const changedDuringConfirmation = "A planned destination changed during confirmation. Run setup again.";
const digest = (bytes: Uint8Array | null) => bytes === null ? "missing" : sha256(bytes);

const readOriginal = (root: string, path: string) => Effect.gen(function* () {
  if (!isAbsolute(root) || isAbsolute(path) || !path || path.split(sep).some((part) => part === ".." || part === ".git" || part === ".jj") || !relative(root, join(root, path))) {
    return yield* new InterviewPlanError({ message: "A planned path is unsafe." });
  }

  const files = yield* ProfileFiles;
  const target = join(root, path);

  if (!(yield* files.check(root, target, "File"))) return null;

  return yield* readBoundedFile(target, maxInterviewContextBytes).pipe(
    Effect.mapError(() => new InterviewPlanError({ message: "Cannot safely read the profile text." })),
  );
});

export const verifyInterviewBaseline = (root: string, plan: InterviewFilePlan, phase: "before-confirmation" | "after-confirmation") => Effect.gen(function* () {
  const bytes = yield* readOriginal(root, plan.path);

  if ((bytes !== null && bytes.byteLength > maxInterviewContextBytes) || digest(bytes) !== plan.expectedDigest) {
    return yield* new InterviewPlanError({ message: phase === "before-confirmation" ? changedDuringInterview : changedDuringConfirmation });
  }
});

// The wizard owns all replacement prompts and the one final save prompt; this
// guard does not write or accept imported confirmation values.
export const guardInterviewConfirmation = <E, R>(root: string, plan: InterviewFilePlan, confirmInTerminal: Effect.Effect<boolean, E, R>) => Effect.gen(function* () {
  yield* verifyInterviewBaseline(root, plan, "before-confirmation");

  if (!(yield* confirmInTerminal)) return false;
  yield* verifyInterviewBaseline(root, plan, "after-confirmation");

  return true;
});

const existingChoices = new Map([
  ["1", "keep"], ["keep", "keep"], ["yes", "keep"], ["2", "adjust"], ["adjust", "adjust"], ["3", "reinterview"], ["reinterview", "reinterview"],
]);

const methodChoices = new Map([
  ["1", "guided"], ["guided", "guided"], ["agent", "guided"], ["2", "short"], ["short", "short"], ["form", "short"], ["3", "later"], ["later", "later"],
]);

const decodeDraft = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const nonblank = (bytes: Uint8Array) => bytes.some((byte) => byte !== 32 && !(byte >= 9 && byte <= 13));

export const runInterviewStep = <R = never, E = never, C = never>(options: InterviewStepOptions<R, E, C>) => Effect.gen(function* () {
  if (options.dryRun) {
    yield* options.io.say("AI interview was skipped in this dry run.");

    return { status: "skipped" } satisfies InterviewStepResult;
  }

  if (options.profileId === undefined) return yield* new InterviewPlanError({ message: "Run the profile step first." });

  const io = new BudgetedInterviewIO(options.io);
  const { root, explicitKeys, recoveredKeys, interactive } = options;
  const answers = { ...options.answers };
  const providedKeys = new Set([...explicitKeys, ...recoveredKeys]);
  const profile = yield* decodeProfileId(options.profileId);
  const path = options.narrativePath ?? join("local_only", "profiles", profile, "profile.md");
  const original = yield* readOriginal(root, path);

  if (original && original.byteLength > maxInterviewContextBytes) {
    yield* io.say("The existing profile is too large for this bounded interview. It was kept unchanged, not truncated. Short-form answers can be collected after you move the old text aside yourself.");

    return { status: "kept" } satisfies InterviewStepResult;
  }

  const resources = yield* NarrativeResources;

  const named = (key: InterviewMenuKey, question: string, choices?: ReadonlyMap<string, string>, fallback?: string) => Effect.gen(function* () {
    const prior = Object.hasOwn(answers, key) ? answers[key] : fallback;

    if (prior !== undefined && !Predicate.isString(prior)) return yield* new InterviewPlanError({ message: `Answer ${key} must be text.` });

    if (explicitKeys.has(key) || (!interactive && Object.hasOwn(answers, key))) {
      if (prior === undefined) return yield* new InterviewMissingAnswer({ key });
      const selected = choices ? choices.get(prior) : prior;

      if (selected === undefined) return yield* new InterviewPlanError({ message: `Answer ${key} is invalid. Choose a listed number.` });

      if (key === "interview_section" && options.recordMenuAnswer) yield* options.recordMenuAnswer(key, prior);

      return selected;
    }

    if (!interactive) return yield* new InterviewMissingAnswer({ key });
    const ask = prior === undefined ? `${question}: ` : `${question} (current: ${prior}; press Enter to keep it): `;

    for (let attempt = 0; attempt < 3; attempt++) {
      const text = stripInterviewAnswer(yield* io.ask(ask)) || prior || "";
      const selected = choices ? choices.get(text) : text;

      if (selected !== undefined) {
        answers[key] = text;

        if (key !== "interview_replacement" && options.recordMenuAnswer) yield* options.recordMenuAnswer(key, text);

        return selected;
      }

      yield* io.say("Choose a listed number.");
    }

    return yield* new InterviewCancelled({ message: "Too many invalid answers." });
  });

  const adjust = (bytes: Uint8Array) => Effect.gen(function* () {
    const sections = adjustableSections(bytes);

    if (Either.isLeft(sections) || !sections.right.length) {
      yield* io.say("This text has no safely editable section. It was preserved. Keep it or explicitly choose Re-interview.");

      return null;
    }

    const choices = new Map<string, string>();

    for (const [index, heading] of sections.right.entries()) {
      const number = String(index + 1);
      yield* io.say(`${number}. ${heading.slice(3)}`);
      choices.set(number, heading);
      choices.set(heading, heading);
    }

    const heading = yield* named("interview_section", "Section to adjust", choices);
    const value = yield* named("interview_replacement", "Replacement text for this section only");

    if (!fitsInterviewText(value, maxInterviewAnswerBytes)) {
      yield* io.say("Replacement text exceeds 4 KiB. The original text was preserved.");

      return null;
    }

    const template = yield* resources.template;
    const section = Object.entries(sectionHeadings).find(([, label]) => label === heading)?.[0];

    if (!section || !hasMeaningfulContent(value) || checkNarrative(fillTemplate(template, { [section]: value }), { requireMinimum: false }).length) {
      yield* io.say("The replacement did not pass the content and privacy checks. The original text was preserved.");

      return null;
    }

    const adjusted = replaceSection(bytes, heading, value);

    if (Either.isLeft(adjusted)) {
      yield* io.say("The section boundary or replacement is unsafe. The original text was preserved.");

      return null;
    }

    const text = decodeDraft(adjusted.right);

    if (options.recordMenuAnswer) yield* options.recordMenuAnswer("interview_replacement", value);

    return text;
  });

  const collect = Effect.gen(function* () {
    let draft = null;

    if (original && nonblank(original)) {
      const keep = caseFold(String(answers.keep_narrative ?? ""));
      const explicitKeep = explicitKeys.has("keep_narrative");

      if (explicitKeep && (keep === "yes" || keep === "y")) return { status: "kept" } satisfies InterviewStepResult;
      const deliberate = explicitKeep && (keep === "no" || keep === "n") && explicitKeys.has("interview_method");

      while (!deliberate) {
        yield* io.say("1. Keep the existing text unchanged\n2. Adjust one recognized section\n3. Re-interview (replace the whole text)");
        const action = yield* named("interview_existing", "Existing profile text", existingChoices, "1");

        if (action === "keep") return { status: "kept" } satisfies InterviewStepResult;

        if (action === "reinterview") break;
        draft = yield* adjust(original);

        if (draft !== null) break;

        if (!interactive || explicitKeys.has("interview_existing")) return { status: "kept" } satisfies InterviewStepResult;
      }
    }

    if (draft === null) {
      yield* io.say("1. Guided interview inside setup with the selected AI program\n2. Short form without AI\n3. Do this later");
      const method = yield* named("interview_method", "How do you want to write your profile?", methodChoices);
      const questions = yield* resources.questions();
      const hasPrimaryAnswer = (facts: Answers) => questions.some((q) => Object.hasOwn(facts, `interview_${q.id}`));

      if (method === "later") {
        yield* io.say("No profile text was planned. Pulse status will remind you.");

        return { status: hasPrimaryAnswer(answers) ? "incomplete" : "later" } satisfies InterviewStepResult;
      }

      const guided = method === "guided" && interactive && options.selectGuided ? yield* options.selectGuided : null;

      if (guided?.executable) yield* io.say(`Guided sends your answers to ${guided.reviewer.harness} using the selected personal-review model and effort.`);
      const template = yield* resources.template;

      const result = yield* runInterviewSession({ questions, template, answers, providedKeys, io, interactive,
        mode: method === "guided" ? "guided" : "short", guided: guided ?? undefined,
        checkpoint: options.checkpoint, monotonicSeconds: options.monotonicSeconds,
      });

      if (result.draft === null) return { status: result.status === "incomplete" || hasPrimaryAnswer(answers) || hasPrimaryAnswer(result.facts) ? "incomplete" : "later" } satisfies InterviewStepResult;
      draft = result.draft;
    }

    const plan: InterviewFilePlan = { path, content: draft, mode: 0o600, overwrite: original !== null, expectedDigest: digest(original) };
    yield* verifyInterviewBaseline(root, plan, "before-confirmation");
    yield* io.say("Profile draft (not saved):");
    yield* io.say(draft);

    return { status: "planned", plan } satisfies InterviewStepResult;
  });

  return yield* collect.pipe(Effect.catchTag("InterviewBudgetExhausted", () => io.say("Interview answer limit reached. The interview is incomplete.").pipe(Effect.as({ status: "incomplete" } satisfies InterviewStepResult))));
});
