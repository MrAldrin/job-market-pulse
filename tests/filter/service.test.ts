import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { GeographyAreas, GeographyAreasLive } from "../../src/lib/server/filter/geography-service.ts";
import { FilterManifests, FilterManifestsLive, FilterSource, FilterSourcePackageResources, prepareCandidates, type ManifestSourceSnapshot } from "../../src/lib/server/filter/service.ts";
import { MAX_SOURCE_ADS } from "../../src/lib/server/filter/manifest.ts";
import { sourceAd, filterSettings } from "./fixtures.ts";

const ad = () => sourceAd(undefined, undefined, { locations: '["Trondheim"]' });
const base = filterSettings();
const geography = { radius_km: 100, origin_latitude: 63.43, origin_longitude: 10.39, origin_source: "synthetic" };
const settings = { ...base, filters: { ...base.filters, geography }, preferences: { ...base.preferences, ...geography } };

const snapshot = (changes: Partial<ManifestSourceSnapshot> = {}): ManifestSourceSnapshot => {
  const row = ad();

  return { ads: [row], listing_count: 1, checked_at: "2026-10-19T12:00:00+00:00", caught_up: "1", location_points: {}, occupation_pairs: { [row.uuid]: [["IT", "Software"]] }, location_binding_digests: {}, ...changes };
};

const sourceLayer = (value: ManifestSourceSnapshot) => Layer.succeed(FilterSource, { read: () => Effect.succeed(value) });
const areaLayer = GeographyAreasLive.pipe(Layer.provide(BunFileSystem.layer));
const layer = (value: ManifestSourceSnapshot) => FilterManifestsLive.pipe(Layer.provide(sourceLayer(value)), Layer.provide(areaLayer), Layer.provide(FilterSourcePackageResources));

const build = Effect.flatMap(FilterManifests, (service) => service.build("invented", settings));

it("counts each ad once at the first rule that removes it", () => {
  const ads = ["General role", "Excluded role", "Excluded role", "General role", "General role"].map((title, i) =>
    sourceAd(`00000000-0000-4000-8000-00000000000${i + 1}`, title, { expires: i === 4 ? "2026-10-19T11:00:00+00:00" : null }));

  const value = snapshot({
    ads, listing_count: 50,
    location_points: Object.fromEntries(ads.map((row, i) => [row.uuid, [[i === 1 ? [60, 0] : [63.43, 10.39]], false]])),
    occupation_pairs: { [ads[0]!.uuid]: [["IT", "Software"]] },
  });

  const selected = { ...settings, preferences: { ...settings.preferences, excluded_title_terms: ["excluded"] } };
  const result = Either.getOrThrow(prepareCandidates(value, selected, new Map(), BigInt(Date.parse(value.checked_at)) * 1000n));

  expect(result.filters).toEqual({ pool: 5, area: 1, exclusions: 1, occupation: 1, other: 1 });
  expect(result.candidates.map((item) => item.id)).toEqual([ads[0]!.uuid]);
});

describe("Filter manifest resource bridge", () => {
  it("uses the actual package-relative area file from an unrelated cwd with no local config", async () => {
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), "pulse-filter-cwd-"));

    try {
      process.chdir(directory);
      const result = await Effect.runPromise(build.pipe(Effect.provide(layer(snapshot())), Effect.provide(FixedOsloClock)));

      expect(result.candidates.map((candidate) => candidate.id)).toEqual([ad().uuid]);
      expect(result.candidates[0]?.geography_reason).toContain("municipality");
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true });
    }
  });

  it("does not read Source or area files when its operation-scoped service is constructed", async () => {
    const inert = FilterManifestsLive.pipe(
      Layer.provide(Layer.succeed(FilterSource, { read: () => Effect.die("eager Source read") })),
      Layer.provide(Layer.succeed(GeographyAreas, { load: () => Effect.die("eager area read") })),
      Layer.provide(FilterSourcePackageResources),
    );

    await Effect.runPromise(Effect.asVoid(FilterManifests).pipe(Effect.provide(inert)));
  });

  it("checks the absolute Source count before freshness or area I/O", async () => {
    const invalid = snapshot({ listing_count: MAX_SOURCE_ADS + 1, checked_at: "invalid" });

    const selected = FilterManifestsLive.pipe(
      Layer.provide(sourceLayer(invalid)), Layer.provide(FilterSourcePackageResources),
      Layer.provide(Layer.succeed(GeographyAreas, { load: () => Effect.die("unexpected area read") })),
    );

    const result = await Effect.runPromise(build.pipe(Effect.either, Effect.provide(selected), Effect.provide(FixedOsloClock)));

    expect(Either.isLeft(result) && result.left.message).toContain("listing count");
  });

  it("does not truncate a Source checked timestamp one microsecond ahead of the injected wall clock", async () => {
    const future = snapshot({ checked_at: "2026-10-19T12:00:00.000001+00:00" });
    const result = await Effect.runPromise(build.pipe(Effect.either, Effect.provide(layer(future)), Effect.provide(FixedOsloClock)));

    expect(Either.isLeft(result) && result.left.message).toContain("future");
  });
});
