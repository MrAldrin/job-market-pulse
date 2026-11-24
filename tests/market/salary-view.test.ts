import { describe, expect, it } from "vitest";
import type { SalaryFacts } from "../../src/lib/contracts/salary.ts";
import { displayLabel, formatNok, monthlyTrend, readSalaryRows, salarySection, yearlyStats, type SalaryRow } from "../../src/lib/server/market/salary-view.ts";

const facts: SalaryFacts = { form: "range", min_nok: 600_000, max_nok: 700_000, period: "year", period_inferred: false, sko_code: "1065", ltr_min: 52, ltr_max: 58, amount_unclear: false };
const row = (uuid: string, overrides: Partial<SalaryRow> = {}): SalaryRow => ({ uuid, title: null, employer: null, form: "single", min_nok: 500_000, max_nok: 500_000, period: "year", period_inferred: false, sko_code: null, ltr_min: null, ltr_max: null, detail_changed: "2026-03-10T09:00:00+00:00", closed: false, ...overrides });

describe("salary view", () => {
  it("displays stated, unclear and missing salary facts", () => {
    expect(displayLabel(facts, true)).toBe("Lønn: 600 000–700 000 kr/år · SKO 1065 · Lønnstrinn 52–58");
    expect(displayLabel(null, false)).toBe("Lønn ukjent");
    expect(displayLabel({ ...facts, form: null, sko_code: null, ltr_min: null, amount_unclear: true }, true)).toBe("Lønn: beløp ukjent");
    expect(formatNok(350.05)).toBe("350,05");
  });
  it("filters before counting and retains closed, outlying and undated facts", () => {
    const rows = [row("b", { min_nok: 9_000_000, max_nok: 9_000_000, closed: true }), row("a", { detail_changed: "2026-02-28T23:30:00-02:00" }), row("c", { form: "vague", detail_changed: "invalid" }), row("d", { form: "vague", detail_changed: "invalid" })];
    const salary = readSalaryRows(rows, new Set(["a", "b", "c"]));
    expect(salary.undated).toBe(1);
    expect(monthlyTrend(salary).months).toEqual([{ month: "2026-03", facts: 2, numeric: 1, median_yearly: null, sko_or_vague: 0 }]);
    const section = salarySection(salary);
    expect(section.ads.map((ad) => ad.job_id)).toEqual(["a", "b"]);
    expect(section.ads[1]).toMatchObject({ closed: true, yearly_midpoint: 9_000_000, outside_plausible_range: true });
  });
  it("uses five values and inclusive quartiles for statistics", () => {
    expect(yearlyStats([1, 2, 3]).median).toBeNull();
    expect(yearlyStats([500, 100, 300, 200, 400])).toEqual({ count: 5, minimum: 100, p25: 200, median: 300, p75: 400, maximum: 500 });
  });
});
