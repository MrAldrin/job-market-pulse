import { Either } from "effect";
import { describe, expect, it } from "vitest";
import type { Candidate, ManifestCommon } from "../../src/lib/contracts/filter.ts";
import { stageInputFingerprint } from "../../src/lib/server/filter/stage-fingerprint.ts";

const common: ManifestCommon = {
  schema_version: 1, profile_id: "invented", profile_fingerprint: "a".repeat(64), preferences_fingerprint: "b".repeat(64), rules_fingerprint: "c".repeat(64), scoring_version: "test",
  fit_preferences: { preferred_terms: [], allowed_occupation_categories: [], preferred_municipalities: [], nearby_municipalities: [], excluded_title_terms: [], excluded_employers: [], excluded_municipalities: [], hard_limits: { geography_radius_km: 40, geography_already_applied: true, geography_radius_is_explicit: true, exact_origin_included: false, other_constraints: "Unknown" } },
};

const candidate: Candidate = { id: "invented", version: "one", title: "Invented role", employer: "Invented Works", locations: [], url: "https://arbeidsplassen.nav.no/stillinger/stilling/invented", expires_at: null, detail_missing: false, geography: "inside", geography_reason: "Synthetic", occupation_categories: ["IT"] };

describe("stage input identity", () => {
  it("binds metadata and geography evidence in both stages", () => {
    const title = { stage: "title_screen", promptVersion: "title-v1" } as const;
    const full = { stage: "full_review", promptVersion: "full-v1", upstreamResultId: "accepted-screen" } as const;

    for (const options of [title, full]) {
      const first = stageInputFingerprint(common, candidate, options);

      expect(Either.isRight(first)).toBe(true);
      expect(stageInputFingerprint(common, { ...candidate, employer: "Changed" }, options)).not.toEqual(first);
      expect(stageInputFingerprint(common, { ...candidate, geography_evidence_digest: "d".repeat(64) }, options)).not.toEqual(first);
      expect(stageInputFingerprint({ ...common, profile_fingerprint: "d".repeat(64) }, candidate, options)).not.toEqual(first);
    }
  });

  it("reuses unchanged content across timestamp-only full-review updates", () => {
    const options = { stage: "full_review", promptVersion: "full-v1", upstreamResultId: "screen", sourceTextFingerprint: "d".repeat(64), snapshotId: "e".repeat(64) } as const;

    expect(stageInputFingerprint(common, candidate, options)).toEqual(stageInputFingerprint(common, { ...candidate, version: "two" }, options));
    expect(stageInputFingerprint(common, candidate, { ...options, upstreamResultId: "other" })).not.toEqual(stageInputFingerprint(common, candidate, options));
  });

  it("rejects full-ad context on title screening and incomplete full-review binding", () => {
    expect(Either.isLeft(stageInputFingerprint(common, candidate, { stage: "title_screen", promptVersion: "v1", sourceTextFingerprint: "d".repeat(64) }))).toBe(true);
    expect(Either.isLeft(stageInputFingerprint(common, candidate, { stage: "full_review", promptVersion: "v1" }))).toBe(true);
    expect(Either.isLeft(stageInputFingerprint(common, candidate, { stage: "full_review", promptVersion: "v1", upstreamResultId: "screen", snapshotId: "e".repeat(64) }))).toBe(true);
    expect(Either.isLeft(stageInputFingerprint(common, candidate, { stage: "title_screen", promptVersion: "\u0000" }))).toBe(true);
  });
});
