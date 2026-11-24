import { expect, it } from "vitest";
import { classifyModelListing, detectHarnesses, helpArgv, parseAdvertisedEfforts } from "../../src/lib/server/judge/reviewer-detect.ts";

it("uses only injected path lookup", () => {
  expect(detectHarnesses((name) => name === "pi" ? "/fake/pi" : null)).toEqual([{ harness: "claude-code", executable: null }, { harness: "pi", executable: "/fake/pi" }]);
  expect(helpArgv("pi", "pi")).toContain("--offline");
});

it("parses model tables and only advertised option blocks", () => {
  expect(classifyModelListing("provider model context max-out thinking images\ntest fake 10 10 yes no\n")).toEqual(["ok", ["test/fake"]]);
  expect(parseAdvertisedEfforts("--thinking low medium high\n--other minimal max", "pi")).toEqual(new Set(["low", "medium", "high"]));
  expect(parseAdvertisedEfforts("thinking=yes", "pi")).toBeNull();
});
