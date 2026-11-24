import { DateTime, Effect } from "effect";
import { expect, test } from "vitest";
import { FixedOsloClock, osloNow } from "../../src/lib/server/clock.ts";

test("test time uses fixed Oslo time rather than the machine timezone or wall clock", async () => {
  const now = await Effect.runPromise(osloNow.pipe(Effect.provide(FixedOsloClock)));

  expect(DateTime.formatIsoZoned(now)).toBe("2026-10-19T14:00:00.000+02:00[Europe/Oslo]");
});
