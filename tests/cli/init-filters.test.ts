import { Effect, Either } from "effect";
import { readFileSync } from "node:fs";
import type { TomlTable } from "smol-toml";
import { expect, test } from "vitest";
import { chooseOccupations, editExclusions } from "../../src/cli/init-filters.ts";
import { chooseSetupProfile } from "../../src/cli/init-profile-choice.ts";
import { InitMissingAnswer, initQuestions, type InitInputs } from "../../src/cli/init-prompts.ts";
import { InterviewCancelled, type InterviewIO } from "../../src/cli/interview-session.ts";
import { decodeCatalog } from "../../src/lib/server/profile/occupation-catalog.ts";
import { parseToml } from "../../src/lib/server/shared/toml.ts";
import supplied from "../fixtures/port-oracle/setup-interview/inputs/answers.json";
import recorded from "../oracle/setup-interview/cli/init.json";

const publicFile = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const catalog = Either.getOrThrow(decodeCatalog(publicFile("../../config/occupation_categories.toml")));

const script = (answers: TomlTable, input: Partial<InitInputs> = {}, responses: readonly string[] = []) => {
  const said: string[] = [];
  const asked: string[] = [];
  const remaining = responses.values();

  const io: InterviewIO = {
    say: (text) => Effect.sync(() => { said.push(text); }),
    ask: (text) => Effect.suspend(() => {
      asked.push(text);
      const reply = remaining.next();

      return reply.done ? Effect.fail(new InterviewCancelled({ message: "Unexpected terminal prompt" })) : Effect.succeed(reply.value);
    }),
  };

  const context = initQuestions(io, {
    answers,
    explicitKeys: new Set(),
    recoveredKeys: new Set(),
    committedDefaults: {},
    nonInteractive: false,
    advanced: false,
    recoveryStep: "all",
    ...input,
  });

  return { context, asked, said };
};

test("an already selected profile keeps the frozen profile menu and ignores a new name prompt", async () => {
  const { context, asked, said } = script({ ...supplied }, { explicitKeys: new Set(Object.keys(supplied)) });
  const choice = await Effect.runPromise(chooseSetupProfile(context, "invented"));
  const stdout = recorded.stdout;

  expect(choice).toEqual({ profileId: "invented", searchMode: "passive" });
  expect(asked).toEqual([]);
  expect(said.join("\n") + "\n").toBe(stdout.slice(stdout.indexOf("Profile: invented"), stdout.indexOf("2/7  AI settings")));
});

test("a fresh setup refuses an invalid slug before accepting the next name", async () => {
  const { context, said, asked } = script({}, {}, ["../another-profile", "invented", "2"]);

  expect(await Effect.runPromise(chooseSetupProfile(context))).toEqual({ profileId: "invented", searchMode: "active" });
  expect(asked).toEqual(["Profile ID (example: scratch-tester): ", "Profile ID (example: scratch-tester): ", "Search mode (current: passive; press Enter to keep it): "]);
  expect(said).toContain("Use lowercase letters, digits and single hyphens, at most 64 characters.");
});

test("named setup answers produce the frozen occupation transcript and preference value", async () => {
  const { context, said, asked } = script({ ...supplied }, { explicitKeys: new Set(Object.keys(supplied)) });
  const preferences = Either.getOrThrow(parseToml(publicFile("../oracle/setup-interview/setup/files/profiles/invented/preferences.toml")));
  const output = await Effect.runPromise(chooseOccupations(context, catalog));
  const stdout = recorded.stdout;

  expect(asked).toEqual([]);
  expect(output).toEqual(["IT"]);
  expect(preferences.jobs).toMatchObject({ allowed_occupation_categories: output });
  expect(said.join("\n") + "\n").toBe(stdout.slice(stdout.indexOf("The filter keeps jobs"), stdout.indexOf("5/7  Profile text")));
});

test("keeping job-area defaults preserves saved entries outside the menu and does not replace Judge terms", async () => {
  const categoryOrder = ["Other historically saved category", "IT"];
  const chosen = { occupation_choices: "4", occupation_IT_mode: "all", allowed_occupation_categories: categoryOrder, preferred_terms: ["new term not owned by Filter"] };
  const { context } = script(chosen, { committedDefaults: { ...chosen, preferred_terms: ["saved Judge term"] } }, ["", ""]);

  expect(await Effect.runPromise(chooseOccupations(context, catalog))).toEqual(categoryOrder);
  expect(chosen.preferred_terms).toEqual(["saved Judge term"]);
});

test("an intentional text edit wins over a typed exclusion list without splitting a kept comma", async () => {
  const answers = { excluded_title_terms: ["label, literal"], excluded_employers: ["Synthetic AS"], excluded_employers_input: "New AS, New AS" };
  const { context, asked } = script(answers, { explicitKeys: new Set(Object.keys(answers)) });

  expect(await Effect.runPromise(editExclusions(context))).toEqual({
    excluded_title_terms: ["label, literal"],
    excluded_employers: ["New AS"],
  });
  expect(asked).toEqual([]);
});

test("a scripted missing occupation answer is recoverable and does not use the display default", async () => {
  const { context, asked } = script({}, { nonInteractive: true });
  const result = await Effect.runPromise(Effect.either(chooseOccupations(context, catalog)));

  expect(Either.isLeft(result) && result.left).toBeInstanceOf(InitMissingAnswer);
  expect(Either.isLeft(result) && result.left).toHaveProperty("key", "occupation_choices");
  expect(asked).toEqual([]);
});
