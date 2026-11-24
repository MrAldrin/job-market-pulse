import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { extractSalary } from "../../src/lib/server/market/salary.ts";
import type { SalaryFacts } from "../../src/lib/contracts/salary.ts";

const empty = { form: null, min_nok: null, max_nok: null, period: null, sko_code: null, ltr_min: null, ltr_max: null, period_inferred: false, amount_unclear: false };
const facts = (partial: Partial<SalaryFacts>) => ({ ...empty, ...partial });

describe("extractSalary", () => {
  it.each([
    ["Lønn: kr 600 000 – 700 000 per år", facts({ form: "range", min_nok: 600000, max_nok: 700000, period: "year" })],
    ["Lønn kr 600.000 til 700.000", facts({ form: "range", min_nok: 600000, max_nok: 700000, period: "year", period_inferred: true })],
    ["450-500 per time", facts({ form: "range", min_nok: 450, max_nok: 500, period: "hour" })],
    ["45-50 000 kr/mnd", facts({ form: "range", min_nok: 45000, max_nok: 50000, period: "month" })],
    ["Timelønn kr 350,50", facts({ form: "single", min_nok: 350.5, max_nok: 350.5, period: "hour" })],
    ["Lønn opptil kr 700 000 i året", facts({ form: "max", max_nok: 700000, period: "year" })],
    ["Vi tilbyr opptil kr 800 000", facts({ form: "max", max_nok: 800000 })],
    ["Lønn fra 500 000 og opptil 600 000", facts({ form: "range", min_nok: 500000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Lønn kr 600 000 og inntil kr 700 000 per år", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["kr 600 000 per år, kr 350 per time", facts({ amount_unclear: true })],
    ["Konkurransedyktig lønn. Lønnstrinn 10-12. SKO 1234.", facts({ form: "vague", sko_code: "1234", ltr_min: 10, ltr_max: 12 })],
    ["Lønn kr 600 000 pluss bonus", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Bonus kr 50 000", empty], ["kr 600 000 - 2027", empty], ["sko 1234", empty],
    ["<p>Lønn kr&nbsp;650&nbsp;000</p>", facts({ form: "single", min_nok: 650000, max_nok: 650000, period: "year", period_inferred: true })],
    ["Lønn kr&#32;600&#32;000", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Lønn kr ٦٠٠ ٠٠٠", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Lønn kr 𝟙𝟚𝟛𝟜𝟝𝟞𝟟 per år", facts({ form: "single", min_nok: 1234567, max_nok: 1234567, period: "year" })],
    ["𝟜𝟝-50 000 kr/mnd", facts({ form: "range", min_nok: 45000, max_nok: 50000, period: "month" })],
    ["ſtillingskode 2468", facts({ sko_code: "2468" })],
    ["stillingsKode 2468", facts({ sko_code: "2468" })],
    ["Bonusordning og lønn kr 600 000", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Lønn kr 0 per time", empty],
    ["Lønnstrinn 45-20", facts({ ltr_min: 20, ltr_max: 45 })],
    ["Lønn 600 000 kr. Ingen bonusordning.", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["Lønn 600 000 kr per år 100 % stilling", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year" })],
    ["Stipendiat lønn 520 000 per år", facts({ form: "single", min_nok: 520000, max_nok: 520000, period: "year" })],
    ["Pensjon: kr 30 000 per måned", empty],
    ["Timelønn opptil 400 kr", facts({ form: "max", max_nok: 400, period: "hour" })],
    ["Lønn kr&Tab;600&Tab;000", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
    ["kr&#x80;600 000", empty],
    ["ølønnsramme 600 000", empty],
    ["LØNN KR 600 000", facts({ form: "single", min_nok: 600000, max_nok: 600000, period: "year", period_inferred: true })],
  ])("extracts %s", (input, expected) => expect(extractSalary(input)).toEqual(expected));
  it("keeps long digit runs out", () => fc.assert(fc.property(fc.integer({ min: 13, max: 200 }), (n) => { expect(extractSalary(`Lønn kr ${"9".repeat(n)} per år`)).toEqual(empty); })));
  it("extracts positive labelled yearly salaries", () => fc.assert(fc.property(fc.integer({ min: 100000, max: 999999 }), (n) => { expect(extractSalary(`Lønn kr ${n}`)).toEqual(facts({ form: "single", min_nok: n, max_nok: n, period: "year", period_inferred: true })); })));

});
