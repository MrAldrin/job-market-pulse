import { Effect, Either } from "effect";
import { expect, test } from "vitest";
import { decodeExample } from "../../src/lib/contracts/example.ts";

const valid = { schema: "pulse.example", schema_version: 1, message: "synthetic" };

test("unknown keys cannot silently enter a strict brick boundary", async () => {
  expect(Either.isLeft(await Effect.runPromise(Effect.either(decodeExample({ ...valid, extra: true }))))).toBe(true);
});

test("wrong types and unsupported versions cannot become valid contracts", async () => {
  for (const invalid of [{ ...valid, message: 7 }, { ...valid, schema_version: 2 }, { ...valid, schema_version: true }]) {
    expect(Either.isLeft(await Effect.runPromise(Effect.either(decodeExample(invalid))))).toBe(true);
  }

  expect(await Effect.runPromise(decodeExample(valid))).toEqual(valid);
});
