import { Option } from "effect";
import { expect, it } from "vitest";
import { parseIsoTime } from "../../src/lib/contracts/iso-time.ts";

it("compares NAV timestamps at microsecond precision across zones", () => {
  const utc = Option.getOrThrow(parseIsoTime("2026-10-19T08:30:00.123455Z"));
  const local = Option.getOrThrow(parseIsoTime("2026-10-19T10:30:00.123456+02:00"));

  expect(local.epochMicros - utc.epochMicros).toBe(1n);
  expect(Option.isNone(parseIsoTime("2026-02-30T12:00:00Z"))).toBe(true);
});
