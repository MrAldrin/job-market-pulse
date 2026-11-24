import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { Digest, ReviewStage } from "../../src/lib/contracts/judge-state.ts";
import { PROMPT_INSTRUCTIONS, STAGE_PROMPT_VERSIONS, promptVersion } from "../../src/lib/server/judge/prompts.ts";

test("new prompt versions come from instruction bytes and differ from the frozen attempts", async () => {
  const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ stage: ReviewStage, prompt_version: Digest })))(JSON.parse(await readFile(new URL("../oracle/basic-run/judge/attempts.json", import.meta.url), "utf8")));
  const expected = new Map(rows.map((row) => [row.stage, row.prompt_version]));

  expect([...expected.keys()].sort()).toEqual(["full_review", "title_screen"]);

  for (const stage of ["title_screen", "full_review"] as const) {
    expect(STAGE_PROMPT_VERSIONS[stage]).not.toBe(expected.get(stage));
    expect(promptVersion(PROMPT_INSTRUCTIONS[stage])).toBe(STAGE_PROMPT_VERSIONS[stage]);
  }
});
