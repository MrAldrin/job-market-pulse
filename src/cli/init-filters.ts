import { Effect, Predicate, Schema } from "effect";
import type { OccupationBox } from "../lib/server/profile/occupation-catalog.ts";
import { caseFold, strip } from "../lib/server/shared/text.ts";
import { InitInputError, type InitQuestions } from "./init-prompts.ts";

type Choice = readonly [value: string, label: string];

const strings = Schema.is(Schema.Array(Schema.String));

const many = (ctx: InitQuestions, key: string, question: string, options: readonly Choice[]) => Effect.gen(function* () {
  const numbers = new Map(options.map(([value], index) => [String(index + 1), value]));

  for (const [index, [, label]] of options.entries()) yield* ctx.say(`${index + 1}. ${label}`);

  const select = (text: string): readonly string[] | null => {
    const word = caseFold(text);

    if (word === "all") return [...numbers.values()];

    if (word === "none" || word === "") return [];
    const selected: string[] = [];

    for (const part of text.split(",")) {
      const value = numbers.get(strip(part));

      if (value === undefined) return null;
      selected.push(value);
    }

    return [...new Set(selected)];
  };

  const answer = yield* ctx.answer(key, {
    prompt: question,
    default: "none",
    validate: (value) => select(value) === null ? "Use comma-separated numbers, for example 1,4,6." : null,
  });

  const result = select(answer);

  if (result === null) return yield* new InitInputError({ message: `Answer ${key} is invalid.` });

  return result;
});

const occupationMode = (name: string) => `occupation_${name}_mode`;
const occupationParts = (name: string) => `occupation_${name}_parts`;

export const chooseOccupations = (ctx: InitQuestions, catalog: readonly OccupationBox[]) => Effect.gen(function* () {
  yield* ctx.say("The filter keeps jobs in the areas you choose. The AI then judges each one against your profile.");
  yield* ctx.say("Enter comma-separated numbers, for example 1,4,6.");

  const saved = ctx.current("allowed_occupation_categories");
  const keys = ["occupation_choices", ...catalog.flatMap(({ name }) => [occupationMode(name), occupationParts(name)])];
  const previous = new Map(keys.map((key) => [key, ctx.current(key)]));

  for (let attempt = 0; attempt < 3; attempt++) {
    const chosen = yield* many(ctx, "occupation_choices", "Which job areas? Use comma-separated numbers, for example 1,4,6.",
      catalog.map(({ name, plain }) => [name, `${name}: ${plain}`]));

    const selected: string[] = [];

    for (const box of catalog) {
      if (!chosen.includes(box.name)) continue;
      let mode = "all";

      if (box.level2.length > 1) {
        yield* ctx.say(`Parts of ${box.name}:`);

        for (const [index, child] of box.level2.entries()) yield* ctx.say(`${index + 1}. ${child}`);

        mode = yield* ctx.answer(occupationMode(box.name), {
          prompt: `All of ${box.name}, or only some parts?`,
          default: "all",
          validate: (value) => value === "all" || value === "some" ? null : "Choose all or some.",
        });
      }

      if (mode === "some") {
        const parts = yield* many(ctx, occupationParts(box.name), "Which parts? Use comma-separated numbers, for example 1,4,6.",
          box.level2.map((name) => [name, name]));

        selected.push(...parts.map((name) => `${box.name} / ${name}`));
      } else selected.push(box.name);
    }

    const edited = keys.some((key) => ctx.inputChanged(key) || ctx.current(key) !== previous.get(key));
    const result = strings(saved) && !edited ? [...saved] : selected;

    if (result.length) {
      const preferred = ctx.committedDefaults.preferred_terms;

      if (preferred !== undefined) ctx.answers.preferred_terms = preferred;
      ctx.answers.allowed_occupation_categories = result;

      return result;
    }

    yield* ctx.say("Choose at least one job area. A title word does not let a job through.");

    if (ctx.nonInteractive || ctx.explicitKeys.has("occupation_choices")) break;
  }

  return yield* new InitInputError({ message: "Choose at least one occupation area." });
});

const exclusions = [
  ["excluded_title_terms", "Words in a job title that always mean no (comma-separated, optional)"],
  ["excluded_employers", "Employers you never want (comma-separated, optional)"],
] as const;

const terms = (ctx: InitQuestions, key: typeof exclusions[number][0], prompt: string) => Effect.gen(function* () {
  const input = `${key}_input`;
  const retained = ctx.current(key);
  const hidden = !ctx.advanced && ctx.recoveryStep === "all" && exclusions.some(([field]) => ctx.inputChanged(field) || ctx.inputChanged(`${field}_input`));
  const explicitList = ctx.explicitKeys.has(key) && !ctx.explicitKeys.has(input);

  if (explicitList || (ctx.inputChanged(key) && !ctx.inputChanged(input))) {
    if (!strings(retained)) return yield* new InitInputError({ message: `Answer ${key} must be a list of text.` });
    ctx.answers[input] = retained.join(", ");

    return [...retained];
  }

  const text = hidden ? (Object.hasOwn(ctx.answers, input) ? ctx.current(input) : "") : yield* ctx.answer(input, { prompt, default: "" });

  if (!Predicate.isString(text)) return yield* new InitInputError({ message: `Answer ${input} must be text.` });

  if (strings(retained) && !ctx.explicitKeys.has(input) && text === retained.join(", ")) return [...retained];

  return [...new Set(text.split(",").map(strip).filter(Boolean))];
});

export const editExclusions = (ctx: InitQuestions) => Effect.gen(function* () {
  const [title, employers] = exclusions;

  const result = {
    excluded_title_terms: yield* terms(ctx, ...title),
    excluded_employers: yield* terms(ctx, ...employers),
  };

  Object.assign(ctx.answers, result);

  return result;
});
