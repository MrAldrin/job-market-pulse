import { FileSystem } from "@effect/platform";
import { Effect, Either, Layer } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { ArtifactProbe, ArtifactProbeLive } from "../../src/lib/server/example/service.ts";
import { compareJson, encode, shortDiff, sortRows } from "../oracle/compare.ts";

const memoryFiles = FileSystem.layerNoop({
  exists: () => Effect.succeed(false),
  readFileString: () => Effect.succeed('{\n  "present": false\n}\n'),
});

const testLayer = ArtifactProbeLive.pipe(Layer.provideMerge(memoryFiles));

test("a missing artifact must not become a present database or initialize a store", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const probe = yield* ArtifactProbe;

    return yield* probe.inspect("/synthetic/not-created.sqlite3");
  }).pipe(Effect.provide(testLayer)));

  expect(result).toEqual({ present: false });
});

test("an altered oracle field fails rather than comparing the golden with itself", async () => {
  const result = await Effect.runPromise(Effect.either(compareJson("independent-golden", { present: true })).pipe(Effect.provide(memoryFiles)));

  expect(Either.isLeft(result)).toBe(true);
  expect(shortDiff(encode({ present: false }), encode({ present: true }))).toContain('+   "present": true');
});

test("normalization never removes array order, timestamps, IDs or numeric spelling differences", () => {
  expect(encode({ ids: ["b", "a"], time: "2026-10-19T12:00:00+00:00" })).toContain('"b",\n    "a"');
  expect(shortDiff('1.0\n', encode(1))).toContain('- 1.0');
});

test("numeric and non-BMP object keys keep Python key order instead of JS enumeration order", () => {
  expect(encode({ "2": "two", "10": "ten" })).toBe('{\n  "10": "ten",\n  "2": "two"\n}\n');
  expect(encode({ "😀": 1, "Ｚ": 2 }).indexOf("Ｚ")).toBeLessThan(encode({ "😀": 1, "Ｚ": 2 }).indexOf("😀"));
});

test("nonfinite numbers cannot silently become null and match an unrelated golden", async () => {
  const result = await Effect.runPromise(Effect.either(compareJson("independent-golden", { present: NaN })).pipe(Effect.provide(memoryFiles)));

  expect(Either.isLeft(result)).toBe(true);
});

test("row normalization is permutation-independent without changing business values", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer(), { maxLength: 30 }), (keys) => {
    const rows = keys.map((key) => [key, "value"] as const);

    expect(sortRows(rows, (row) => [row[0]])).toEqual(sortRows(rows.toReversed(), (row) => [row[0]]));
  }));
});
