import { expect, it } from "vitest";
import { osloTime } from "../../src/lib/server/shared/display-time.ts";

it("formats aware Oslo timestamps without guessing naive zones", () => {
  expect(osloTime("2026-10-20T11:52:29.540585+00:00")).toBe("2026-10-20 13:52:29 CEST");
  expect(osloTime("2026-12-20T11:52:29Z")).toBe("2026-12-20 12:52:29 CET");
  expect(osloTime("2026-10-20T11:52:29")).toBe("2026-10-20T11:52:29");
  expect(osloTime("unknown")).toBe("unknown");
});

it("handles Date instances without throwing", () => {
  expect(osloTime(new Date("2026-12-20T11:52:29Z"))).toBe("2026-12-20 12:52:29 CET");
});
