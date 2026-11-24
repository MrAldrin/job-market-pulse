import { Data, Effect, Predicate } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { TomlTable, TomlValue } from "smol-toml";
import { caseFold, strip } from "../lib/server/shared/text.ts";
import { InterviewCancelled, type InterviewIO } from "./interview-session.ts";

export class InitInputError extends Data.TaggedError("InitInputError")<{ readonly message: string }> {}

export class InitMissingAnswer extends Data.TaggedError("InitMissingAnswer")<{ readonly key: string }> {}

type ValidateAnswer = (text: string) => string | null;

interface TextQuestion {
  readonly prompt: string;
  readonly default?: string | undefined;
  readonly validate?: ValidateAnswer | undefined;
}

export const askInitText = (io: InterviewIO, question: TextQuestion) => Effect.gen(function* () {
  const fallback = question.default;
  const prompt = fallback === undefined ? `${question.prompt}: ` : `${question.prompt} (current: ${fallback}; press Enter to keep it): `;

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = strip(yield* io.ask(prompt));

    if (caseFold(text) === "quit") return yield* new InterviewCancelled({ message: "Setup cancelled." });
    const answer = text || fallback || "";
    const reason = question.validate?.(answer);

    if (!reason) return answer;
    yield* io.say(reason);
  }

  return yield* new InterviewCancelled({ message: "Too many invalid answers." });
});

export interface InitInputs {
  readonly answers: TomlTable;
  readonly explicitKeys: ReadonlySet<string>;
  readonly recoveredKeys: ReadonlySet<string>;
  readonly committedDefaults: Readonly<TomlTable>;
  readonly nonInteractive: boolean;
  readonly advanced: boolean;
  readonly recoveryStep: string;
}

export const initQuestions = (io: InterviewIO, input: InitInputs) => {
  const { answers, committedDefaults, nonInteractive } = input;
  const explicitKeys = new Set(input.explicitKeys);
  const recoveredKeys = new Set(input.recoveredKeys);
  const current = (key: string): TomlValue | undefined => Object.hasOwn(answers, key) ? answers[key] : undefined;

  const answer = (key: string, question: TextQuestion) => Effect.gen(function* () {
    const previous = Object.hasOwn(answers, key) ? current(key) : question.default;

    if (previous !== undefined && !Predicate.isString(previous)) return yield* new InitInputError({ message: `Answer ${key} must be text.` });

    if (explicitKeys.has(key) || (nonInteractive && Object.hasOwn(answers, key))) {
      if (previous === undefined) return yield* new InitMissingAnswer({ key });
      const reason = question.validate?.(previous);

      if (reason) return yield* new InitInputError({ message: `Answer ${key} is invalid. ${reason}` });

      return previous;
    }

    if (nonInteractive) return yield* new InitMissingAnswer({ key });
    const selected = yield* askInitText(io, { ...question, default: previous });
    answers[key] = selected;

    return selected;
  });

  const activeExplicitKeys: ReadonlySet<string> = explicitKeys;
  const activeRecoveredKeys: ReadonlySet<string> = recoveredKeys;

  return {
    ...input,
    explicitKeys: activeExplicitKeys,
    recoveredKeys: activeRecoveredKeys,
    forget: (key: string): void => {
      delete answers[key];
      explicitKeys.delete(key);
      recoveredKeys.delete(key);
    },
    answer,
    current,
    say: io.say,
    inputChanged: (key: string): boolean => explicitKeys.has(key) || (recoveredKeys.has(key) && !isDeepStrictEqual(current(key), committedDefaults[key])),
  };
};

export type InitQuestions = ReturnType<typeof initQuestions>;
