import { Data, Effect, Either, Match, Predicate } from "effect";
import { InterviewTurn, type InterviewTurnRequest } from "../lib/server/judge/interview-turn.ts";
import type { Reviewer } from "../lib/server/judge/reviewers.ts";
import { checkNarrative, hasMeaningfulContent, normalizeSalary, normalizeWorkplace, renderAnswers, type Answers, type Question } from "../lib/server/profile/narrative.ts";
import { parseStrictContractJson } from "../lib/server/shared/strict-contract-json.ts";
import { caseFold } from "../lib/server/shared/text.ts";

export const maxInterviewContextBytes = 128 * 1024;
export const maxInterviewAnswerBytes = 4 * 1024;
const maxResponseBytes = 16 * 1024;
const maxHumanAttempts = 56;
const maxInvocations = 32;
const maxWaitSeconds = 600;
const special = new Set(["minimum_salary", "work_location"]);

export class InterviewCancelled extends Data.TaggedError("InterviewCancelled")<{ readonly message: string }> {}

export class InterviewBudgetExhausted extends Data.TaggedError("InterviewBudgetExhausted")<{}> {}

export class InterviewTurnFailure extends Data.TaggedError("InterviewTurnFailure")<{}> {}

export interface InterviewIO {
  readonly ask: (question: string) => Effect.Effect<string, InterviewCancelled>;
  readonly say: (text: string) => Effect.Effect<void>;
}

export const fitsInterviewText = (text: string, bytes: number): boolean =>
  text.isWellFormed() && new TextEncoder().encode(text).byteLength <= bytes;

// Python str.strip includes these controls and does not strip a BOM.
// eslint-disable-next-line no-control-regex
export const stripInterviewAnswer = (text: string): string => text.replace(/^[\p{White_Space}\x1c-\x1f]+|[\p{White_Space}\x1c-\x1f]+$/gu, "");

export class BudgetedInterviewIO {
  #attempts = 0;

  constructor(private readonly io: InterviewIO) {}

  get attempts(): number { return this.#attempts; }
  get remaining(): number { return maxHumanAttempts - this.#attempts; }

  say(text: string) { return this.io.say(text); }

  ask(question: string) {
    return Effect.gen(this, function* () {
      while (this.remaining) {
        this.#attempts++;
        const answer = yield* this.io.ask(question);

        if (caseFold(stripInterviewAnswer(answer)) === "quit") return yield* new InterviewCancelled({ message: "Interview cancelled." });

        if (fitsInterviewText(answer, maxInterviewAnswerBytes)) return answer;
        yield* this.say("Enter at most 4 KiB of text.");
      }

      return yield* new InterviewBudgetExhausted();
    });
  }
}

interface GuidedTurnResult {
  readonly text: string;
  readonly reportedModel?: string;
}

export interface GuidedInterview<R> {
  readonly executable: string;
  readonly reviewer: Reviewer;
  readonly callTurn: (request: InterviewTurnRequest) => Effect.Effect<GuidedTurnResult, InterviewTurnFailure | InterviewCancelled, R>;
}

export const guidedInterview = (reviewer: Reviewer, executable: string | null): GuidedInterview<InterviewTurn> | null =>
  executable ? {
    executable,
    reviewer,
    callTurn: (request) => Effect.flatMap(InterviewTurn, (service) => service.run(request)).pipe(
      Effect.mapError(() => new InterviewTurnFailure()),
    ),
  } : null;

export interface InterviewSessionOptions<R, E, C> {
  readonly questions: readonly Question[];
  readonly template: string;
  readonly answers: Answers;
  readonly providedKeys: ReadonlySet<string>;
  readonly io: BudgetedInterviewIO;
  readonly interactive: boolean;
  readonly mode: "short" | "guided";
  readonly guided?: GuidedInterview<R> | undefined;
  readonly monotonicSeconds?: (() => number) | undefined;
  readonly checkpoint?: ((facts: InterviewFacts) => Effect.Effect<void, E, C>) | undefined;
  readonly existingText?: string;
}

type Status = "ready" | "incomplete" | "later";

type Fact = string | number | null;

export type InterviewFacts = Readonly<Record<string, Fact>>;

interface InterviewSessionResult {
  readonly status: Status;
  readonly draft: string | null;
  readonly facts: Answers;
  readonly invocations: number;
  readonly waitSeconds: number;
  readonly humanAttempts: number;
}

const validIndex = (value: number, question: Question) => Number.isInteger(value) && value >= 0 && value < question.follow_up.length;

const response = (text: string, question: Question) => {
  const parsed = parseStrictContractJson(text, maxResponseBytes);

  if (Either.isLeft(parsed)) return null;
  const { question_id, reflection, follow_up } = parsed.right;

  if (Object.keys(parsed.right).length !== 3 || question_id !== question.id || !Predicate.isString(reflection)
    || !stripInterviewAnswer(reflection) || Array.from(reflection).length > 1200
    || /\p{C}/u.test(reflection) || /\p{Z}/u.test(reflection.replaceAll(" ", ""))) return null;

  if (follow_up === null) return { reflection, index: null };

  if (!Predicate.isBigInt(follow_up) || !validIndex(Number(follow_up), question)) return null;

  return { reflection, index: Number(follow_up) };
};

const answerKey = (question: Question) => `interview_${question.id}`;

export const validateRetainedInterviewFacts = (questions: readonly Question[], answers: Answers, provided: ReadonlySet<string>) => {
  const facts: Record<string, Fact> = {};
  const allowed = new Map<string, (value: Fact) => boolean>();

  for (const question of questions) {
    const key = answerKey(question);

    allowed.set(key, (value) => Predicate.isString(value) && fitsInterviewText(value, maxInterviewAnswerBytes) && Either.isRight(normalize(value, question.id)));

    if (special.has(question.id)) continue;

    if (question.hard) allowed.set(key + "_strict", (value) => value === "yes" || value === "no");
    allowed.set(key + "_followup_index", (value) => value === null || (Predicate.isNumber(value) && validIndex(value, question)));
    allowed.set(key + "_followup_answer", (value) => Predicate.isString(value) && fitsInterviewText(value, maxInterviewAnswerBytes));
  }

  for (const key of provided) {
    const validate = allowed.get(key);

    if (!validate || !Object.hasOwn(answers, key)) continue;
    const value = answers[key];

    if (!(Predicate.isString(value) || Predicate.isNumber(value) || value === null) || !validate(value)) return null;
    facts[key] = value;
  }

  for (const question of questions) {
    const key = answerKey(question);

    if (Object.hasOwn(facts, key + "_followup_answer") && facts[key + "_followup_index"] == null) return null;
  }

  return facts;
};

const normalize = (value: string, kind: string) => {
  const text = hasMeaningfulContent(value) ? value : "";

  if (kind === "minimum_salary") return normalizeSalary(text);

  if (kind === "work_location") return normalizeWorkplace(text);

  return Either.right(text);
};

const prompt = (question: Question, facts: Readonly<Record<string, Fact>>, existingText: string | null) => {
  const quote = JSON.stringify;
  const followUps = question.follow_up.map((item) => quote(item)).join(", ");
  const answers = Object.entries(facts).map(([key, value]) => `${quote(key)}: ${quote(value)}`).join(", ");

  // Keep the frozen stdin JSON separators; they count towards the prompt limit.
  return `{"current_question_id": ${quote(question.id)}, "trusted_question": {"ask": ${quote(question.ask)}, "why": ${quote(question.why)}, "follow_up": [${followUps}]}, "untrusted_context": {"user_answers": {${answers}}, "existing_text": ${quote(existingText)}}}`;
};

export const runInterviewSession = <R = never, E = never, C = never>(options: InterviewSessionOptions<R, E, C>) => Effect.gen(function* () {
  const { questions, template, io, interactive, guided, checkpoint } = options;
  const retained = validateRetainedInterviewFacts(questions, options.answers, options.providedKeys);
  const facts = retained ?? {};
  const done = new Set<string>();
  const now = options.monotonicSeconds ?? (() => performance.now() / 1000);
  let invocations = 0;
  let waitSeconds = 0;
  let late = false;
  let notice = false;
  let mode = options.mode;

  const finish = (status: Status): InterviewSessionResult => {
    let draft: string | null = null;

    if (status === "ready" && Object.entries(facts).some(([key, value]) => !key.endsWith("_strict") && Predicate.isString(value) && hasMeaningfulContent(value))) {
      const candidate = renderAnswers(template, questions, facts);

      if (Either.isRight(candidate) && !checkNarrative(candidate.right).length) draft = candidate.right;
    }

    return { status: status === "ready" && draft === null ? "incomplete" : status, draft, facts: { ...facts }, invocations, waitSeconds, humanAttempts: io.attempts };
  };

  const save = (values: Readonly<Record<string, Fact>>) => Effect.gen(function* () {
    Object.assign(facts, values);

    if (checkpoint) yield* checkpoint({ ...facts });
  });

  const read = (key: string, question: string, kind: string, persist = true) => Effect.gen(function* () {
    const supplied = Object.hasOwn(facts, key) || options.providedKeys.has(key);

    while (true) {
      const raw = supplied ? facts[key] : interactive ? yield* io.ask(question + ": ") : undefined;

      if (!Predicate.isString(raw)) return null;
      const text = stripInterviewAnswer(raw);
      let error = "Answer yes or no.";
      let value: string | undefined;

      if (kind === "strict") {
        const folded = caseFold(text);

        if (folded === "y" || folded === "yes") value = "yes";

        if (folded === "n" || folded === "no") value = "no";
      } else {
        const normalized = normalize(text, kind);

        if (Either.isRight(normalized)) value = normalized.right;
        error = kind === "minimum_salary" ? "Enter a positive whole NOK amount or skip." : "Choose 1, 2 and/or 3, all, none, or skip.";
      }

      if (value !== undefined) {
        if (persist && facts[key] !== value) yield* save({ [key]: value });

        return value;
      }

      yield* io.say(error);

      if (supplied) return null;
    }
  });

  const fallback = (retry: boolean) => Effect.gen(function* () {
    if (!interactive) return "short";

    while (true) {
      yield* io.say(retry
        ? "1. Retry the selected AI program\n2. Continue with the short form without AI\n3. Do this later"
        : "1. Continue with the short form without AI\n2. Do this later");
      const choice = stripInterviewAnswer(yield* io.ask("Choose a number: "));

      if (retry && (choice === "1" || choice === "retry")) return "retry";

      if (choice === (retry ? "2" : "1") || choice === "short") return "short";

      if (choice === (retry ? "3" : "2") || choice === "later") return "later";
      yield* io.say("Choose one of the listed options.");
    }
  });

  const canCall = () => !late && invocations < maxInvocations && waitSeconds < maxWaitSeconds;

  const reflect = (selection: GuidedInterview<R>, question: Question) => Effect.gen(function* () {
    while (true) {
      if (!io.remaining) return yield* new InterviewBudgetExhausted();

      if (!canCall()) {
        yield* io.say("The guided interview program budget is exhausted.");

        return yield* fallback(false);
      }

      const existing = options.existingText ?? null;
      const stdin = prompt(question, facts, existing);

      if ((existing !== null && !existing.isWellFormed()) || !fitsInterviewText(stdin, maxInterviewContextBytes)) {
        yield* io.say("The interview context is too large or invalid. It was not truncated.");

        return yield* fallback(false);
      }

      const timeoutSeconds = Math.min(60, maxWaitSeconds - waitSeconds);
      invocations++;
      const start = now();

      const turn = yield* selection.callTurn({ executable: selection.executable, reviewer: selection.reviewer, prompt: stdin, timeoutSeconds }).pipe(
        Effect.catchTag("InterviewTurnFailure", () => Effect.succeed(null)),
      );

      const elapsed = Math.max(0, now() - start);
      waitSeconds += elapsed;

      if (elapsed > timeoutSeconds) late = true;

      if (turn && !late && turn.reportedModel !== undefined && turn.reportedModel !== selection.reviewer.model && !notice) {
        yield* io.say("NOTICE: The reported model ID differs from the requested ID. Alias resolution or provider substitution is unverified. Pulse did not change the request.");
        notice = true;
      }

      const reply = turn && !late ? response(turn.text, question) : null;

      if (!reply) {
        yield* io.say("The guided interview could not continue. No AI text was saved.");
        const choice = yield* fallback(canCall());

        if (choice === "retry") continue;

        return choice;
      }

      yield* io.say("AI reflection (unconfirmed): " + reply.reflection);
      const followUp = reply.index !== null ? question.follow_up[reply.index] : undefined;

      if (followUp !== undefined) {
        const key = answerKey(question);
        const answer = yield* read(key + "_followup_answer", followUp, "", false);

        if (answer === null) return "incomplete";
        yield* save({ [key + "_followup_index"]: reply.index, [key + "_followup_answer"]: answer });
      }

      return "continue";
    }
  });

  if (!retained) {
    yield* io.say("Retained interview answers are invalid or too large. They were not truncated.");

    return finish("incomplete");
  }

  return yield* Effect.gen(function* () {
    if (mode === "guided") {
      if (!interactive) mode = "short";
      else if (!guided?.executable) {
        yield* io.say("No interview program is selected. Use the short form or return later.");

        if ((yield* fallback(false)) === "later") return finish("later");
        mode = "short";
      } else yield* io.say("Guided sends your answers and supplied existing text to the selected AI program.");
    }

    while (true) {
      let switched = false;

      for (const question of questions) {
        const key = answerKey(question);
        const prior = facts[key];

        if (done.has(question.id) || (mode === "short" && !question.short && !(Predicate.isString(prior) && hasMeaningfulContent(prior)))) continue;

        const ask = Match.value(question.id).pipe(
          Match.when("minimum_salary", () => "Optional STRICT minimum ANNUAL salary before tax in NOK for full-time work (digits only; blank skips)"),
          Match.when("work_location", () => "Equally acceptable arrangements: 1 on-site, 2 hybrid, 3 fully remote (select numbers, all, none, or blank to skip)"),
          Match.orElse(() => question.ask),
        );

        const value = yield* read(key, ask, question.id);

        if (value === null) return finish("incomplete");

        if (value && question.hard && !special.has(question.id) && (yield* read(key + "_strict", "Is this a strict requirement? yes/no", "strict")) === null) return finish("incomplete");
        done.add(question.id);

        if (mode === "guided" && guided && value && !special.has(question.id) && !Object.hasOwn(facts, key + "_followup_answer") && !options.providedKeys.has(key + "_followup_answer")) {
          const outcome = yield* reflect(guided, question);

          if (outcome === "later" || outcome === "incomplete") return finish(outcome);

          if (outcome === "short") {
            mode = "short";
            switched = true;
            break;
          }
        }
      }

      if (!switched) return finish("ready");
    }
  }).pipe(Effect.catchTag("InterviewBudgetExhausted", () => io.say("Interview answer limit reached. The interview is incomplete.").pipe(Effect.as(finish("incomplete")))));
});
