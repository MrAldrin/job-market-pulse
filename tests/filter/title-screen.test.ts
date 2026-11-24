import { Either } from "effect";
import { describe, expect, it } from "vitest";
import type { TitleScreenEnvelope } from "../../src/lib/contracts/fit-review.ts";
import { buildManifest, manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { decodeTitleScreen, validateTitleScreen } from "../../src/lib/server/filter/review.ts";
import { filterSettings, uuid, version } from "./fixtures.ts";

const candidate = { id: uuid, version, title: "Developer", employer: "Example", locations: ["Near"], url: "https://arbeidsplassen.nav.no/stillinger/stilling/" + uuid, expires_at: null, detail_missing: false, geography: "inside" as const, geography_reason: "Synthetic evidence", occupation_categories: ["IT"] };
const manifest = Either.getOrThrow(buildManifest(Either.getOrThrow(manifestCommon("fixture", filterSettings())), [candidate, { ...candidate, id: "00000000-0000-4000-8000-000000000002", title: "Sales manager" }], version));
const now = 1_792_414_800_000_000n;

const constructed = (): TitleScreenEnvelope => ({
  schema_version: 1, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id,
  assessed_at: "2026-10-19T15:00:00+02:00", complete: true,
  assessments: manifest.candidates.map((item, index) => ({ id: item.id, version: null, outcome: index === 0 ? "advance_to_full_review" : "screened_out", reason: index === 0 ? "  Relevant development role.  " : "  Sales focus.  " })),
});

describe("canonical title screening", () => {
  it("returns ordered outcomes with trusted versions, stripped reasons and UTC assessment time", () => {
    const rows = Either.getOrThrow(validateTitleScreen(manifest, constructed(), now));

    expect(rows).toEqual(manifest.candidates.map((item, index) => ({ id: item.id, version: item.version, outcome: index === 0 ? "advance_to_full_review" : "screened_out", reason: index === 0 ? "Relevant development role." : "Sales focus.", assessed_at: "2026-10-19T13:00:00+00:00" })));
  });

  it("rejects wrong binding, missing coverage, stale source and expired candidates", () => {
    const input = constructed();

    expect(Either.isLeft(validateTitleScreen(manifest, { ...input, profile_id: "other" }, now))).toBe(true);
    expect(Either.isLeft(validateTitleScreen(manifest, { ...input, assessments: input.assessments.slice(1) }, now))).toBe(true);
    expect(Either.isLeft(validateTitleScreen(manifest, input, now, 0n))).toBe(true);
    expect(Either.isLeft(validateTitleScreen(manifest, input, now + 2n * 86_400_000_000n))).toBe(true);
    expect(Either.isLeft(validateTitleScreen({ ...manifest, candidates: manifest.candidates.map((item) => ({ ...item, expires_at: "2026-10-19T12:00:00Z" })) }, input, now))).toBe(true);
  });

  it("decodes real reply values and refuses invalid outcomes, blank reasons and unencoded versions", () => {
    const input = { ...constructed(), schema_version: 1n };
    const row = input.assessments[0];

    if (row === undefined) throw new Error("Missing fixture candidate");
    expect(Either.isLeft(decodeTitleScreen({ ...input, assessments: [{ ...row, outcome: "maybe" }, ...input.assessments.slice(1)] }))).toBe(true);
    expect(Either.isLeft(decodeTitleScreen({ ...input, assessments: [{ ...row, reason: "  " }, ...input.assessments.slice(1)] }))).toBe(true);
    expect(Either.isLeft(decodeTitleScreen(constructed()))).toBe(true);
    const decoded = Either.getOrThrow(decodeTitleScreen(input));

    expect(Either.isRight(validateTitleScreen(manifest, decoded, now))).toBe(true);
  });
});
