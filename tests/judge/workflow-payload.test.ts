import { readFile } from "node:fs/promises";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CandidateManifest } from "../../src/lib/contracts/filter.ts";
import { AdTextBatch } from "../../src/lib/contracts/source-review.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { buildPayload } from "../../src/lib/server/judge/workflow-payload.ts";
import type { PythonJson } from "../../src/lib/server/shared/python-json.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";

const text = (path: string) => readFile(path, "utf8");
const manifest = async (bundle: string, request: number) => Either.getOrThrow(Either.flatMap(parseJsonInput(await text(`tests/oracle/${bundle}/judge/request-${request}-manifest.json`)), decodeStrict(CandidateManifest)));
const profile = async () => Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ narrative: Schema.String, preferences: Schema.String })))(await text("tests/fixtures/port-oracle/basic-run/inputs/profile.json"));

const adTexts = async (bundle: string) => {
  const captured = Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ calls: Schema.Array(Schema.Unknown), result: AdTextBatch })))(await text(`tests/oracle/${bundle}/judge/detail-request-00000000-0000-0000-0000-000000000001.json`));

  return new Map(captured.result.available.map((ad) => [ad.listing_id, ad]));
};

describe("Judge payload bytes", () => {
  for (const bundle of ["basic-run", "resume-run"]) {
    it(`${bundle} keeps narrative, preferred terms and response bindings but removes admission-only inputs`, async () => {
      const narrative = (await profile()).narrative;
      const ads = await adTexts(bundle);

      for (const [request, stage] of [[1, "title_screen"], [2, "full_review"]] as const) {
        const payload = Either.getOrThrow(buildPayload(stage, await manifest(bundle, request), narrative, stage === "full_review" ? ads : null));
        const frozen = JSON.parse(await text(`tests/oracle/${bundle}/judge/request-${request}-user-prompt.txt`));
        const actual = JSON.parse(payload.user_prompt);
        expect(actual).toEqual({ profile: frozen.profile, preferences: { preferred_terms: frozen.preferences.preferred_terms },
          response_template: frozen.response_template,
          candidates: frozen.candidates.map(({ geography: _geo, geography_reason: _reason, occupation_categories: _categories, ...listing }: Record<string, PythonJson>) => listing),
        });
        expect(payload.system_prompt).toContain("Admission filters are already applied");
        expect(payload.system_prompt).not.toBe(await text(`tests/oracle/${bundle}/judge/request-${request}-system-prompt.txt`));
        expect(payload.request_bytes).toBe(new TextEncoder().encode(JSON.stringify({ system_prompt: payload.system_prompt, user_prompt: payload.user_prompt })).length);
      }
    });
  }

  it("rejects a changed narrative or missing full-review text instead of sending a partial request", async () => {
    const selected = await manifest("basic-run", 2);
    expect(Either.isLeft(buildPayload("full_review", selected, "changed", null))).toBe(true);
    expect(Either.isLeft(buildPayload("full_review", selected, (await profile()).narrative, null))).toBe(true);
  });
});
