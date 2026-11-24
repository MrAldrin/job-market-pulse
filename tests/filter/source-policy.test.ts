import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeTitleEvidence } from "../../src/lib/server/filter/evidence-pack.ts";
import { FilterInputError } from "../../src/lib/server/filter/errors.ts";
import { makeSourcePolicy, scoreJobRows, sourceReportRadius, type SourceSnapshot } from "../../src/lib/server/filter/source-policy.ts";
import { NEUTRAL_SCREEN } from "../../src/lib/server/filter/screen-context.ts";
import { filterSettings, sourceAd, uuid, version } from "./fixtures.ts";

const areas = new Map([ ["near", { kommunenummer: "1", name: "Near", hull: [[0, 0] as const] }] ]);
const snapshot = (ads = [sourceAd()]): SourceSnapshot => ({ ads, location_points: {}, occupation_pairs: {} });

describe("structural Source policy", () => {
  it("hands operator reports the full Profile radius without applying the 40 km admission ceiling", () => {
    const base = filterSettings();
    const settings = { ...base, preferences: { ...base.preferences, radius_km: 72.5 } };

    expect(sourceReportRadius(settings)).toBe(72.5);
    expect(sourceReportRadius({ ...settings, preferences: { ...settings.preferences, radius_km: 12.5 } })).toBe(12.5);
  });
  it("fetches allowed categories independently of interest and fetches missing categories independently of admission", () => {
    const policy = Either.getOrThrow(makeSourcePolicy(filterSettings(), areas, NEUTRAL_SCREEN));
    const input = { ...snapshot(), occupation_pairs: { [uuid]: [["IT", ""] as const] } };

    expect(policy.locationCandidates(input)).toEqual([{ uuid }]);
    expect(policy.locationCandidates(snapshot())).toEqual([]);
    expect(policy.insideJobs(snapshot())).toEqual([{ uuid, source_changed_at: version }]);
    expect(policy.rankMissing(input.ads)).toEqual([{ uuid, interest_score: 0 }]);
  });

  it("keeps manual exclusions explicit without changing missing-detail priority or hiding malformed SQL JSON", () => {
    const settings = filterSettings();
    const selected = { rules_fingerprint: "c".repeat(64), excludeTitle: () => "synthetic exclusion" };
    const policy = Either.getOrThrow(makeSourcePolicy({ ...settings, rules_fingerprint: selected.rules_fingerprint }, areas, selected));
    const input = { ...snapshot(), occupation_pairs: { [uuid]: [["IT", ""] as const] } };

    expect(policy.rankMissing(input.ads)).toHaveLength(1);
    expect(policy.locationCandidates(input)).toEqual([]);
    expect(policy.insideJobs(input)).toEqual([]);
    expect(Either.isLeft(makeSourcePolicy(settings, areas, selected))).toBe(true);
    expect(() => policy.rankMissing([sourceAd(uuid, "Role", { topics: "malformed" })])).toThrow(FilterInputError);
    expect(Either.isLeft(scoreJobRows(snapshot([sourceAd(uuid, "Role", { topics: "malformed" })]), settings.preferences, selected, areas))).toBe(true);
  });

  it("uses exact point precedence, incomplete caveats, UUID canonicalization and retained score ordering", () => {
    const second = "00000000-0000-4000-8000-000000000002";
    const third = "00000000-0000-4000-8000-000000000003";

    const input: SourceSnapshot = {
      ...snapshot([sourceAd(second, "rescue instructor", { detail_missing: 1 }), sourceAd(uuid, "first aid training"), sourceAd(third), sourceAd("invalid")]),
      location_points: { [second]: [[[0n, 0n]], false], [uuid]: [[[5n, 5n]], true], [third]: [[[5n, 5n]], false] },
    };

    const evidence = Either.getOrThrow(decodeTitleEvidence(new TextEncoder().encode(JSON.stringify({
      schema_version: 1, topics: [{ name: "rescue", pattern: "first aid" }],
      roles: [{ name: "rescue", pattern: "rescue instructor" }], source_tags: [],
    }))));

    const jobs = Either.getOrThrow(scoreJobRows(input, filterSettings().preferences, NEUTRAL_SCREEN, areas, { offline: true, evidence }));

    expect(jobs.map((job) => job.uuid)).toEqual([second, uuid, third]);
    expect(jobs.map((job) => job.geography.status)).toEqual(["inside", "unknown", "outside"]);
    expect(jobs[0]?.assessment.unknowns).toEqual([
      "Suitability, salary, seniority, language, and remote-work terms are not established.",
      "Details unavailable; summary fields only.", "Offline snapshot may be stale; verify the listing on NAV.",
    ]);
    expect(Either.getOrThrow(scoreJobRows(snapshot([sourceAd("{" + uuid.replaceAll("-", "").toUpperCase() + "}")]), filterSettings().preferences, NEUTRAL_SCREEN, areas))[0]?.uuid).toBe(uuid);
  });

  it("orders tied jobs by ID, not distance, municipality or first-seen time", () => {
    const other = "00000000-0000-4000-8000-000000000009";
    const settings = filterSettings();
    const prefs = { ...settings.preferences, preferred_municipalities: ["Near"] };

    const input: SourceSnapshot = {
      ...snapshot([sourceAd(other, "Role", { first_seen: "2026-10-01", locations: '["Near"]' }), sourceAd(uuid, "Role", { first_seen: "2026-10-19" })]),
      location_points: { [other]: [[[0, 0]], false], [uuid]: [[[0.1, 0]], false] },
    };

    const jobs = Either.getOrThrow(scoreJobRows(input, prefs, NEUTRAL_SCREEN, areas));

    expect(jobs.map((job) => job.uuid)).toEqual([uuid, other]);
  });

  it("never manufactures or pads a Source candidate", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 50 })), (numbers) => {
      const ads = numbers.map((number) => sourceAd("00000000-0000-4000-8000-" + String(number).padStart(12, "0")));
      const input: SourceSnapshot = { ...snapshot(ads), occupation_pairs: Object.fromEntries(ads.map((row, index) => [row.uuid, index % 2 ? [["IT", ""]] : []])) };
      const policy = Either.getOrThrow(makeSourcePolicy(filterSettings(), areas, NEUTRAL_SCREEN));
      const ids = new Set(ads.map((row) => row.uuid));

      expect(policy.locationCandidates(input).every((row) => ids.has(row.uuid))).toBe(true);
      expect(policy.insideJobs(input).every((row) => ids.has(row.uuid))).toBe(true);
    }));
  });
});
