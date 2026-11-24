import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import type { TomlTable } from "smol-toml";
import { expect, test, vi } from "vitest";
import { chooseSetupArea } from "../../src/cli/init-geography.ts";
import { initQuestions, type InitInputs } from "../../src/cli/init-prompts.ts";
import { PostcodeAreaError } from "../../src/lib/server/profile/errors.ts";
import { parseToml } from "../../src/lib/server/shared/toml.ts";
import named from "../fixtures/port-oracle/setup-interview/inputs/answers.json";
import fixture from "../fixtures/port-oracle/setup-interview/manifest.json";
import expected from "../oracle/setup-interview/cli/init.json";

const runInputs = (answers: TomlTable, input: Partial<InitInputs> = {}, pending: string[] = []) => {
  const said: string[] = [];
  const asked: string[] = [];

  const context = initQuestions({
    say: (line) => Effect.sync(() => { said.push(line); }),
    ask: (prompt) => Effect.sync(() => {
      asked.push(prompt);
      const answer = pending.shift();

      if (answer === undefined) throw new Error("Unexpected prompt");

      return answer;
    }),
  }, {
    answers, explicitKeys: new Set(), recoveredKeys: new Set(), committedDefaults: {}, nonInteractive: true, advanced: false, recoveryStep: "all", ...input,
  });

  return { context, said, asked };
};

const date = fixture.clock.slice(0, 10);
const unavailable = () => Effect.fail(new PostcodeAreaError({ message: "Do not display this detail." }));

test("invented postcode replay matches the frozen area transcript and derived fields", async () => {
  const { context, said, asked } = runInputs({ ...named }, { explicitKeys: new Set(Object.keys(named)) });
  const lookup = vi.fn((postcode: string) => Effect.succeed({ postcode, poststed: "INVENTED", latitude: 60, longitude: 10 }));
  const area = await Effect.runPromise(chooseSetupArea(context, { date, lookup }));
  const golden = await readFile(new URL("../oracle/setup-interview/setup/files/profiles/invented/preferences.toml", import.meta.url), "utf8");
  const geography = await Effect.runPromise(parseToml(golden));

  expect(lookup).toHaveBeenCalledExactlyOnceWith("0123");
  expect(asked).toEqual([]);
  expect(said.join("\n") + "\n").toBe(expected.stdout.slice(expected.stdout.indexOf("Jobs outside your area"), expected.stdout.indexOf("4/7  Job areas")));
  expect(area).toEqual(geography.geography);
});

test("a new place drops the recovered coordinates before looking up the new postcode", async () => {
  const recovered = {
    place_query: "0124", area_postcode: "0124", home_label: "0124 OLD", origin_source: "invented", origin_latitude: 60,
    origin_longitude: 10, latitude_input: "60.0", longitude_input: "10.0", radius_input: "25",
  };

  const { context, asked } = runInputs({ ...recovered }, {
    recoveredKeys: new Set(Object.keys(recovered)), nonInteractive: false,
  }, ["0125", "", "30"]);

  const lookup = vi.fn((postcode: string) => Effect.succeed({ postcode, poststed: "NEW", latitude: 61, longitude: 11 }));

  expect(await Effect.runPromise(chooseSetupArea(context, { date, lookup }))).toMatchObject({ area_postcode: "0125", origin_latitude: 61, origin_longitude: 11 });
  expect(lookup).toHaveBeenCalledExactlyOnceWith("0125");
  expect(context.recoveredKeys.has("latitude_input")).toBe(false);
  expect(asked).toHaveLength(3);
});

test("complete recovered origin evidence is reused without lookup", async () => {
  const answers = {
    place_query: "0124", area_postcode: "0124", home_label: "0124 DRAFT", origin_source: "invented", origin_latitude: 60,
    origin_longitude: 10, latitude_input: "60.0", longitude_input: "10.0", radius_input: "25",
  };

  const { context } = runInputs(answers, { recoveredKeys: new Set(Object.keys(answers)) });
  const lookup = vi.fn(unavailable);

  expect(await Effect.runPromise(chooseSetupArea(context, { date, lookup }))).toMatchObject({ area_postcode: "0124", origin_latitude: 60, origin_longitude: 10 });
  expect(lookup).not.toHaveBeenCalled();
});

test("manual entry is bounded and never calls postcode lookup", async () => {
  const answers = { latitude_input: "6_0.0", longitude_input: "+1e1", home_label: "Invented area", radius_input: "0.1" };
  const explicitKeys = new Set(Object.keys(answers));
  const { context } = runInputs(answers, { explicitKeys });
  const lookup = vi.fn(unavailable);

  expect(await Effect.runPromise(chooseSetupArea(context, { date, lookup }))).toEqual({
    area_postcode: "", home_label: "Invented area", origin_source: "entered by hand", origin_latitude: 60, origin_longitude: 10, radius_km: 0.1,
  });

  for (const radius_input of ["0", "Infinity", "0x40", "1000.1"]) {
    const invalid = runInputs({ ...answers, radius_input }, { explicitKeys });

    await expect(Effect.runPromise(chooseSetupArea(invalid.context, { date, lookup }))).rejects.toThrow("Answer radius_input is invalid.");
  }

  expect(lookup).not.toHaveBeenCalled();
});

test("named lookup failure is sanitized and does not retry", async () => {
  const { context, said } = runInputs({ place_query: "0124" }, { explicitKeys: new Set(["place_query"]) });
  const lookup = vi.fn(unavailable);

  await expect(Effect.runPromise(chooseSetupArea(context, { date, lookup }))).rejects.toThrow("No usable area for the supplied place_query.");
  expect(said.at(-1)).toContain("For manual coordinates use pulse init --advanced --step geography.");
  expect(said.join("\n")).not.toContain("Do not display this detail.");
  expect(lookup).toHaveBeenCalledOnce();
});
