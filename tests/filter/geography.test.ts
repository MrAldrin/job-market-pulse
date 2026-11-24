import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Layer, Predicate } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { areaInsideRadius, assessAreaLabels, assessGeography, assessLocation, decodeAreaExtents, haversine, point, normalizeName as frozenNormalizeName } from "../../src/lib/server/filter/geography.ts";
import type { JsonInput } from "../../src/lib/server/shared/json-input.ts";
import { normalized } from "../../src/lib/server/shared/text.ts";
import { GeographyAreas, GeographyAreasLive } from "../../src/lib/server/filter/geography-service.ts";

// Synthetic ASCII labels only: this is not a Unicode NFKC parity implementation.
const normalizeName = normalized;
const json = (municipalities: JsonInput, name_collisions: JsonInput = []) => JSON.stringify({ municipalities, name_collisions });
const decode = (text: string) => decodeAreaExtents(text, normalizeName);
const failure = (text: string) => Either.getOrThrow(Either.flip(decode(text)));
const extent = (name: string, hull: readonly (readonly (number | boolean)[])[] = [[0, 0]]) => ({ kommunenummer: "1", name, hull });
const areas = () => Either.getOrThrow(decodeAreaExtents(json([extent("Near"), extent("Far", [[10, 10]])]), normalizeName));

describe("geography", () => {
  it("validates finite numeric points without boolean coercion", () => {
    expect(point(true, 0)).toBeNull();
    expect(point(NaN, 0)).toBeNull();
    expect(point(91, 0)).toBeNull();
    expect(point(-90, 180)).toEqual([-90, 180]);
  });
  it("uses points first, retains incomplete caveats, and never treats incomplete outside as outside", () => {
    const origin = [0, 0] as const;
    expect(assessLocation(origin, [[1, 1]], ["Near"], 1, false, areas(), normalizeName).status).toBe("outside");
    expect(assessGeography(origin, [[1, 1]], 1, true)).toMatchObject({ status: "unknown", point_based: true });
    expect(assessGeography(origin, [[0, 0]], 1, true).reason).toContain("Other listed locations lack coordinates.");
    expect(assessGeography(null, [[0, 0]], 1).point_based).toBe(false);
  });
  it("requires every vertex plus tolerance and never marks areas outside", () => {
    expect(areaInsideRadius([0, 0], [[0, 0]], 0.009)).toBeNull();
    expect(areaInsideRadius([0, 0], [[0, 0]], 0.01)).toBe(0.01);
    expect(areaInsideRadius([0, 0], [[0, 0], [1, 1]], 1)).toBeNull();
    expect(areaInsideRadius([0, 0], [[0, false]], 5)).toBeNull();
    expect(assessAreaLabels([0, 0], ["Far"], 1, areas(), normalizeName).status).toBe("unknown");
  });
  it("handles duplicate labels and unknown labels as separate locations", () => {
    const all = assessAreaLabels([0, 0], ["Near", "Near"], 1, areas(), normalizeName);
    expect(all.reason).toBe("Whole municipalities (Near, Near) lie within 1 km straight-line of the locality origin; upper-bound distance 0.0 km; no street address resolved.");
    expect(assessAreaLabels([0, 0], ["Near", "missing"], 1, areas(), normalizeName).reason).toContain("Other listed locations are not proven inside");
  });
  it("rejects malformed vertices and duplicate normalized names but skips collision names", () => {
    expect(Either.isLeft(decodeAreaExtents(json([extent("A"), extent("a")]), normalizeName))).toBe(true);
    expect(Either.isLeft(decodeAreaExtents(json([extent("A", [[true, 0]])]), normalizeName))).toBe(true);
    expect(Either.getOrThrow(decodeAreaExtents(json([extent("A"), extent("a")], ["a"]), normalizeName)).size).toBe(0);
  });
  it.each([
    [null, null], [17, 17n], [1.25, 1.25], [true, true],
    [{ arbitrary: [null, 2] }, { arbitrary: [null, 2n] }],
    [[1, "x", null], [1n, "x", null]],
  ])("retains opaque kommunenummer metadata %j", (input, expected) => {
    const loaded = Either.getOrThrow(decode(json([{ ...extent("A"), kommunenummer: input }])));
    expect(loaded.get("a")?.kommunenummer).toEqual(expected);
  });
  it("retains exact integer metadata and last-wins duplicate JSON fields", () => {
    const loaded = Either.getOrThrow(decode('{"name_collisions":["a"],"name_collisions":[],"municipalities":[{"name":"B","name":"A","kommunenummer":null,"kommunenummer":9007199254740993,"hull":[[0,0]]}],"extra":{"ignored":true}}'));
    expect(loaded.get("a")).toEqual({ name: "A", kommunenummer: 9007199254740993n, hull: [[0, 0]] });
  });
  it("skips collision rows before absent or invalid hull and metadata checks", () => {
    const rows = [
      { name: "A" }, { name: "a", hull: null },
      { name: " A ", kommunenummer: { opaque: true }, hull: [[true, 0]] },
    ];

    expect(Either.getOrThrow(decode(json(rows, ["a"]))).size).toBe(0);
  });
  it("validates each name before collision skipping and duplicate names before later hulls", () => {
    for (const item of [{}, { name: null }, { name: 1 }, { name: false }, { name: [] }, { name: {} }]) {
      expect(failure(json([item], ["a"]))._tag).toBe("GeographyError");
    }

    expect(failure(json([extent("A"), { name: "a" }])).message).toBe("Duplicate municipality name in area extents");
    expect(failure(json([extent("A"), { name: "a", hull: [[true, 0]] }])).message).toBe("Duplicate municipality name in area extents");
    expect(failure(json([{ name: "A", hull: [[true, 0]] }])).message).toBe("Invalid area extent vertex");
    // Do not prevalidate later rows before processing earlier duplicates.
    expect(failure(json([extent("A"), extent("a"), { name: null }])).message).toBe("Duplicate municipality name in area extents");
  });
  it("requires noncollision fields, without treating explicit null metadata as missing", () => {
    for (const row of [{ name: "A" }, { name: "A", hull: [] }, { name: "A", kommunenummer: null }]) {
      expect(failure(json([row]))._tag).toBe("GeographyError");
    }

    expect(Either.getOrThrow(decode(json([{ name: "A", kommunenummer: null, hull: [] }]))).get("a")?.kommunenummer).toBeNull();
  });
  it.each([[], "", {}])("preserves empty Python municipality and hull iterables %j", (empty) => {
    expect(Either.getOrThrow(decode(json(empty))).size).toBe(0);
    expect(Either.getOrThrow(decode(json([{ ...extent("A"), hull: empty }]))).get("a")?.hull).toEqual([]);
  });
  it.each([null, true, 1, "x", { key: "value" }])("rejects invalid nonempty/noniterable municipality and hull values %j", (value) => {
    expect(failure(json(value))._tag).toBe("GeographyError");
    expect(failure(json([{ ...extent("A"), hull: value }]))._tag).toBe("GeographyError");
  });
  it.each([null, true, 1, "a", {}, [null], [1], [true], [[]], [{}]])("rejects non-list/string collision data %j as an approved resource-boundary deviation", (collisions) => {
    expect(failure(json([], collisions))._tag).toBe("GeographyError");
  });
  it("accepts empty and nonempty collision string lists, including blank labels", () => {
    expect(Either.getOrThrow(decode(json([extent("")], [""]))).size).toBe(0);
    expect(Either.getOrThrow(decode(json([extent("Near")], ["other", " "]))).size).toBe(1);
  });
  it.each([null, [], "", {}, { municipalities: [] }, { name_collisions: [] }])("rejects malformed resource roots %j", (root) => {
    expect(failure(JSON.stringify(root))._tag).toBe("GeographyError");
  });
  it.each([null, {}, "ab", [], [0], [0, 0, 0], [true, 0], [0, false], ["0", 0], [91, 0], [0, 181]])("rejects malformed or invalid vertices %j", (vertex) => {
    expect(failure(json([extent("A"), { ...extent("B"), hull: [vertex] }]))._tag).toBe("GeographyError");
  });
  it("accepts integer and float coordinate tokens, rejects overflowing coordinates", () => {
    const text = '{"name_collisions":[],"municipalities":[{"name":"A","kommunenummer":null,"hull":[[0,1.0],[-90,180]]}]}';
    expect(Either.getOrThrow(decode(text)).get("a")?.hull).toEqual([[0, 1], [-90, 180]]);
    expect(failure(text.replace("1.0", "1e999")).message).toBe("Invalid area extent vertex");
  });
  it("uses the injected normalizer for loader and area label matching", () => {
    const injected = (name: string) => name === "Alias" ? "near" : normalized(name);
    const loaded = Either.getOrThrow(decodeAreaExtents(json([extent("Near")]), injected));
    expect(assessAreaLabels([0, 0], ["Alias"], 1, loaded, injected).status).toBe("inside");
    expect(Either.getOrThrow(decodeAreaExtents(json([{ name: "Alias" }], ["Near"]), injected)).size).toBe(0);
  });
  it("uses the math.radians multiplication order and includes the exact distance boundary", () => {
    const origin = [59.9, 10.7] as const;
    const target = [60.1, 11.3] as const;
    const [a, b] = origin.map((value) => value * (Math.PI / 180));
    const [c, d] = target.map((value) => value * (Math.PI / 180));
    const expected = 6371.0088 * 2 * Math.asin(Math.sqrt(Math.sin((c! - a!) / 2) ** 2 + Math.cos(a!) * Math.cos(c!) * Math.sin((d! - b!) / 2) ** 2));
    expect(haversine(origin, target)).toBe(expected);
    expect(assessGeography(origin, [target], expected).status).toBe("inside");
  });
  it("defaults to no municipality evidence when extents are empty", () => {
    expect(assessLocation([0, 0], [], ["Near"], 40, false, new Map(), normalizeName)).toMatchObject({ status: "unknown", distance_km: null, point_based: false });
    expect(areaInsideRadius([0, 0], [], 40)).toBeNull();
  });
  it("formats radius like Python general formatting", () => {
    expect(assessGeography([0, 0], [[0, 0]], 1234567).reason).toContain("1.23457e+06 km");
    expect(assessGeography([0, 0], [[0, 0]], 0.00001).reason).toContain("1e-05 km");
  });
  it("has symmetric distance and never returns outside for municipality-only evidence", () => {
    const latitude = fc.double({ min: -90, max: 90, noNaN: true });
    const longitude = fc.double({ min: -180, max: 180, noNaN: true });
    fc.assert(fc.property(latitude, longitude, latitude, longitude, (a, b, c, d) => {
      expect(haversine([a, b], [c, d])).toBeCloseTo(haversine([c, d], [a, b]), 8);
      expect(assessAreaLabels([a, b], ["Far", "unknown"], 1, areas(), normalizeName).status).not.toBe("outside");
    }));
  });
});

const fileLayer = GeographyAreasLive.pipe(Layer.provide(BunFileSystem.layer));

const loadFile = (path: string) => Effect.runPromise(Effect.either(Effect.gen(function* () {
  const service = yield* GeographyAreas;

  return yield* service.load(path, normalizeName);
}).pipe(Effect.provide(fileLayer))));

it("rejects unreadable files, malformed UTF-8, malformed JSON and BOM through the byte filesystem layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-geography-"));

  try {
    expect(Either.getOrThrow(Either.flip(await loadFile(directory)))._tag).toBe("GeographyError");
    const path = join(directory, "resource.json");
    // Invalid bytes inside an otherwise valid JSON string must not be replaced.
    const prefix = new TextEncoder().encode('{"name_collisions":[],"municipalities":[],"ignored":"');
    const suffix = new TextEncoder().encode('"}');

    for (const content of [new Uint8Array([...prefix, 0xff, ...suffix]), "{", "\ufeff" + json([])]) {
      await writeFile(path, content);
      expect(Either.getOrThrow(Either.flip(await loadFile(path)))._tag).toBe("GeographyError");
    }

    await writeFile(path, json([]));
    expect(Either.getOrThrow(await loadFile(path)).size).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("loads the checked-in data and treats a missing file as empty through the filesystem layer", async () => {
  const layer = GeographyAreasLive.pipe(Layer.provide(BunFileSystem.layer));

  const result = await Effect.runPromise(Effect.gen(function* () {
    const service = yield* GeographyAreas;
    const loaded = yield* service.load("config/area_extents.json", normalizeName);
    const missing = yield* service.load("config/does-not-exist.json", normalizeName);

    return [loaded.size, missing.size];
  }).pipe(Effect.provide(layer)));

  expect(result[0]).toBeGreaterThan(0);
  expect(result[1]).toBe(0);
});

it("preserves own and nested prototype-like opaque metadata without inherited required fields", () => {
  const text = '{"name_collisions":[],"municipalities":[{"name":"A","kommunenummer":{"__proto__":{"kept":true},"constructor":1,"prototype":2},"hull":[[0,0]],"__proto__":{"ignored":true}}],"__proto__":{"ignored":true}}';
  const loaded = Either.getOrThrow(decode(text));
  const metadata = loaded.get("a")?.kommunenummer;

  expect(metadata).toEqual({ ["__proto__"]: { kept: true }, constructor: 1n, prototype: 2n });

  if (Predicate.isRecord(metadata)) {
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
  }

  for (const text of [
    '{"__proto__":{"name_collisions":[],"municipalities":[]}}',
    '{"name_collisions":[],"municipalities":[{"__proto__":{"name":"A","hull":[],"kommunenummer":"1"}}]}',
    '{"name_collisions":[],"municipalities":[{"name":"A","hull":[],"__proto__":{"kommunenummer":"1"}}]}',
  ]) expect(Either.isLeft(decode(text))).toBe(true);
});

it("caches successful missing and decoded resources but never caches a failed decode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-geography-cache-"));
  const missing = join(directory, "missing.json");
  const malformed = join(directory, "malformed.json");

  try {
    await writeFile(malformed, "malformed");
    await Effect.runPromise(Effect.gen(function* () {
      const service = yield* GeographyAreas;
      const first = yield* service.load(missing);
      yield* Effect.promise(() => writeFile(missing, json([extent("Later")])));
      expect(yield* service.load(missing)).toBe(first);
      expect(first.size).toBe(0);
      expect(Either.isLeft(yield* Effect.either(service.load(malformed)))).toBe(true);
      yield* Effect.promise(() => writeFile(malformed, json([extent("Valid")])));
      const loaded = yield* service.load(malformed);
      expect(loaded.has("valid")).toBe(true);
      yield* Effect.promise(() => writeFile(malformed, "malformed again"));
      expect(yield* service.load(malformed)).toBe(loaded);
    }).pipe(Effect.provide(GeographyAreasLive.pipe(Layer.provide(BunFileSystem.layer)))));
  } finally {
    await rm(directory, { recursive: true });
  }
});

it("uses independently audited frozen NFKC by default through the real area-resource layer", async () => {
  expect(frozenNormalizeName("  Ｓｔｒａße  ")).toBe("strasse");
  expect(frozenNormalizeName("Ａ\u1add\u030a")).toBe("a\u1add\u030a");
  expect(frozenNormalizeName("\u{1ccd6}")).toBe("\u{1ccd6}");
  const directory = await mkdtemp(join(tmpdir(), "pulse-geography-normalization-"));
  const path = join(directory, "resource.json");

  try {
    await writeFile(path, json([extent("Ｆｉｘｔｕｒｅ") ]));
    const loaded = await Effect.runPromise(Effect.flatMap(GeographyAreas, (service) => service.load(path)).pipe(Effect.provide(GeographyAreasLive.pipe(Layer.provide(BunFileSystem.layer)))));

    expect(loaded.has("fixture")).toBe(true);
    expect(assessAreaLabels([0, 0], ["fixture"], 40, loaded, frozenNormalizeName).status).toBe("inside");
  } finally {
    await rm(directory, { recursive: true });
  }
});
