import { Either } from "effect";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Candidate, ManifestCommon } from "../../src/lib/contracts/filter.ts";
import { buildManifest, buildManifestBatches, sourceFreshness } from "../../src/lib/server/filter/manifest.ts";

const common: ManifestCommon = {
  schema_version: 1, profile_id: "invented", profile_fingerprint: "a".repeat(64),
  preferences_fingerprint: "b".repeat(64), rules_fingerprint: "c".repeat(64), scoring_version: "title-evidence-hard-radius-v3",
  fit_preferences: {
    preferred_terms: [], allowed_occupation_categories: ["IT"], preferred_municipalities: [], nearby_municipalities: [],
    excluded_title_terms: [], excluded_employers: [], excluded_municipalities: [],
    hard_limits: { geography_radius_km: 40, geography_radius_is_explicit: true, geography_already_applied: true, exact_origin_included: false, other_constraints: "Use only constraints stated in the supplied profile; otherwise unknown." },
  },
};

const checked = "2026-01-01T00:00:00+00:00";

const candidate = (id: string, version = checked): Candidate => ({
  id, version, title: "Invented role", employer: "Invented Works", locations: ["Invented"],
  url: "https://arbeidsplassen.nav.no/stillinger/stilling/" + id,
  expires_at: null, detail_missing: false, geography: "inside", geography_reason: "Synthetic inside evidence", occupation_categories: ["IT"],
});

const value = <A>(result: Either.Either<A, unknown>): A => {
  expect(Either.isRight(result)).toBe(true);

  if (Either.isLeft(result)) throw new Error("Synthetic test construction failed");

  return result.right;
};

describe("manifest construction", () => {
  it("does not count punctuation after an escaped title quote as JSON separator whitespace", () => {
    const prefix = "a".repeat(1_981_000) + '"';
    const plain = buildManifest(common, [{ ...candidate("one"), title: prefix + "aa".repeat(5000) }], checked);
    const punctuation = buildManifest(common, [{ ...candidate("one"), title: prefix + ":,".repeat(5000) }], checked);

    expect(Either.isRight(plain)).toBe(true);
    expect(Either.isRight(punctuation)).toBe(true);
  });
  it("binds complete candidate records but not source check metadata", () => {
    const first = value(buildManifest(common, [candidate("one")], checked));
    const refreshed = value(buildManifest(common, [candidate("one")], "2026-01-02T00:00:00+00:00"));
    const changed = value(buildManifest(common, [{ ...candidate("one"), employer: "Changed" }], checked));

    expect(first.manifest_id).toBe(refreshed.manifest_id);
    expect(first.coverage_id).toBe(refreshed.coverage_id);
    expect(changed.coverage_id).not.toBe(first.coverage_id);
    expect(changed.manifest_id).not.toBe(first.manifest_id);
    expect(first).not.toHaveProperty("_eligible_candidates");
  });

  it("uses version descending then ID order rather than relevance or caller order", () => {
    const rows = [candidate("z"), candidate("a"), candidate("new", "2026-01-02T00:00:00Z")];
    const manifest = value(buildManifest(common, rows, checked, { limit: 2 }));

    expect(manifest.candidates.map((item) => item.id)).toEqual(["new", "a"]);
    expect(manifest.truncated).toBe(true);
    expect(rows.map((item) => item.id)).toEqual(["z", "a", "new"]);
  });

  it("explicit batches may include reviewed IDs and retain source priority", () => {
    const rows = [candidate("a"), candidate("b"), candidate("c")];
    const manifest = value(buildManifest(common, rows, checked, { candidateIds: ["c", "a"], excludeIds: new Set(["a"]) }));

    expect(manifest.candidates.map((item) => item.id)).toEqual(["a", "c"]);
    expect(manifest.candidate_offset).toBeNull();
    expect(manifest.batch_index).toBe(0);
    expect(manifest.reviewed_count).toBe(1);
    expect(Either.isLeft(buildManifest(common, rows, checked, { candidateIds: ["missing"] }))).toBe(true);
    expect(Either.isLeft(buildManifest(common, rows, checked, { candidateIds: ["a", "a"] }))).toBe(true);
  });

  it("batch union contains every pending input exactly once without filling a quota", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.uuid(), { maxLength: 50 }), fc.integer({ min: 1, max: 20 }), (ids, limit) => {
      const rows = ids.map((id) => candidate(id));
      const excluded = new Set(ids.filter((_, index) => index % 3 === 0));
      const batches = value(buildManifestBatches(common, rows, checked, { limit, excludeIds: excluded }));
      const actual = batches.flatMap((batch) => batch.candidates.map((item) => item.id));

      expect(actual).toEqual(ids.filter((id) => !excluded.has(id)).sort());
      expect(new Set(actual).size).toBe(actual.length);
      expect(new Set(batches.map((batch) => batch.coverage_id)).size).toBeLessThanOrEqual(1);
    }));
  });

  it("rejects rather than truncates excessive pool, invalid cap and duplicate identity", () => {
    expect(Either.isLeft(buildManifest(common, [candidate("a"), candidate("a")], checked))).toBe(true);
    expect(Either.isLeft(buildManifest(common, [], checked, { limit: 121 }))).toBe(true);
    expect(Either.isLeft(buildManifest(common, [], checked, { limit: 1.5 }))).toBe(true);
    expect(Either.isLeft(buildManifestBatches(common, [candidate("a"), candidate("b")], checked, { limit: 1 }, 1))).toBe(true);
  });

  it("normalizes source check offset and keeps microsecond freshness boundaries", () => {
    const manifest = value(buildManifest(common, [], "2026-01-01T01:00:00.000001+01:00"));

    expect(manifest.checked_at).toBe("2026-01-01T00:00:00.000001+00:00");
    const now = 1_767_225_600_000_001n;

    expect(Either.isRight(sourceFreshness(checked, "1", now, 1n))).toBe(true);
    expect(Either.isLeft(sourceFreshness(checked, "1", now, 0n))).toBe(true);
    expect(Either.isLeft(sourceFreshness(checked, "0", now))).toBe(true);
    expect(Either.isLeft(sourceFreshness(checked, "1", now - 2n))).toBe(true);
  });
});
