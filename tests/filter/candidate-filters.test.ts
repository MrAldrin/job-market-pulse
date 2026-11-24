import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { admissionAllowed, filterEligible, occupationAllowed, occupationLabels } from "../../src/lib/server/filter/candidate-filters.ts";
import { defaultPreferences } from "../../src/lib/server/profile/settings.ts";

describe("occupation admission", () => {
  it("does not admit a preferred title when occupation evidence is missing", () => {
    const preferences = { ...defaultPreferences, preferred_terms: ["developer"], allowed_occupation_categories: ["IT"] };

    expect(admissionAllowed("developer", [], preferences)).toBe(false);
    expect(admissionAllowed("unrelated", [[" IT ", "Platform"]], preferences)).toBe(true);
  });

  it("normalizes Unicode and spacing but does not broaden an exact level-two rule", () => {
    expect(occupationAllowed([["Straße", "Data"]], ["STRASSE / data"])).toBe(true);
    expect(occupationAllowed([["Straße", "Other"]], ["STRASSE / data"])).toBe(false);
    expect(occupationAllowed([["Straße", "Other"]], ["STRASSE"])).toBe(true);
    expect(occupationAllowed([["A", "B / C"]], ["A / B / C"])).toBe(true);
    expect(occupationLabels([["Z", ""], ["A", "Data"], ["Z", ""]])).toEqual(["A / Data", "Z"]);
  });

  it("Filter only removes input jobs across realistic rules, expiry and exclusions", () => {
    const date = fc.bigInt({ min: BigInt(Date.parse("2026-01-01T00:00:00Z")) * 1000n, max: BigInt(Date.parse("2027-01-01T00:00:00Z")) * 1000n });
    const occupation = fc.constantFrom(["IT", "Software"] as const, ["IT", "Data"] as const, ["Engineering", "Mechanical"] as const);

    const job = fc.record({
      title: fc.constantFrom("Software engineer", "Data analyst", "Mechanical engineer"),
      excludedReason: fc.option(fc.constantFrom("title exclusion: academic post", "explicit employer exclusion"), { nil: null }),
      expiresAt: fc.option(date, { nil: null }),
      occupationPairs: fc.array(occupation, { maxLength: 3 }),
    });

    const rules = fc.array(fc.constantFrom("IT", "IT / Software", "Engineering / Mechanical"), { maxLength: 3 });

    fc.assert(fc.property(fc.array(job, { maxLength: 30 }), rules, date, (jobs, allowed, now) => {
      const result = filterEligible(jobs, { ...defaultPreferences, allowed_occupation_categories: allowed }, now);
      let previous = -1;

      for (const item of result) {
        const index = jobs.indexOf(item, previous + 1);

        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
    }));
  });

  it("keeps null expiry but removes exact-now expiry and explicit exclusions", () => {
    const preferences = { ...defaultPreferences, allowed_occupation_categories: ["IT"] };
    const base = { title: "Any", excludedReason: null, occupationPairs: [["IT", ""]] as const };
    const open = { ...base, expiresAt: null };
    const future = { ...base, expiresAt: 11n };

    expect(filterEligible([open, { ...base, expiresAt: 10n }, future, { ...base, expiresAt: null, excludedReason: "" }], preferences, 10n)).toEqual([open, future]);
  });
});
