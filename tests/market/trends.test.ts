import { Either } from "effect";
import { expect, it } from "vitest";
import type { MarketAd, SavedMarketSnapshot } from "../../src/lib/contracts/market.ts";
import type { Taxonomy } from "../../src/lib/server/market/taxonomy.ts";
import { captureWeek, periodCoverage } from "../../src/lib/server/market/periods.ts";
import { funnelMarketContext, marketSection, reviewedTrendSection, risingUnknownTitleWords, trendSeries } from "../../src/lib/server/market/trends.ts";

const tax: Taxonomy = { version: "invented-v1", enabled: true, text_min_hits: 2, title_exclusions: [], families: [{ key: "software_development", label: "Software development", title: [/developer/i], text: [] }, { key: "mixed_data", label: "Mixed data roles", title: [/data/i], text: [] }], terms: [] };
const saved = (label: string, changes: Partial<SavedMarketSnapshot["info"]> = {}): SavedMarketSnapshot => ({ info: { id: 1, label, period_start: `${label}-01`, period_end: `${label}-31`, source: "invented history", sampled: false, ad_count: 10, taxonomy_version: tax.version, created_at: "2026-11-01T00:00:00+00:00", basis: "titles", ...changes }, counts: { families: { software_development: 1, other: 9 }, terms: { "retained/Tool": 1 }, tech_terms: {} }, unknown_words: { vibecoding: 1 }, words_complete: true });
const ad = (uuid: string, published: string): MarketAd => ({ uuid, published, title: "Developer", employer: "Invented Works", municipality: "INVENTED", text: "", occupations: "" });

it("keeps missing historical periods null and retained taxonomy keys distinct from zero", () => {
  const result = Either.getOrThrow(marketSection([saved("2026-08"), saved("2026-10")], tax, "2026-11-10"));
  expect(result?.monthly.periods.map((period) => period.ad_count)).toEqual([10, null, 10]);
  expect(result?.monthly.terms[0]).toMatchObject({ key: "retained/Tool", group: "retained", counts: [1, null, 1], tech_counts: [null, null, null] });
  expect(trendSeries([saved("2026-08"), saved("2026-10")], tax, "month", "titles", "2026-11-10").labels).toEqual(["2026-08", "2026-10"]);
});

it("does not turn an early capture or short stored range into complete historical coverage", () => {
  const partial = saved("2026-10", { created_at: "2026-10-15T12:00:00+00:00" }).info;
  expect(periodCoverage(partial, ["2026-10-01", "2026-10-31"], "2026-11-10")).toBe("partial");
  expect(periodCoverage({ ...partial, created_at: "2026-11-01T00:00:00Z", period_end: "2026-10-15" }, ["2026-10-01", "2026-10-31"], "2026-11-10")).toBe("unverified");
  expect(captureWeek(Date.parse("2026-10-18T22:30:00Z"))).toBe("week-2026-W43");
});

it("recounts reviewed first-seen history only for the exported funnel and leaves later months empty", () => {
  const ads = [ad("reviewed", "2026-08-10T12:00:00Z"), ad("outside", "2026-10-01T12:00:00Z")];
  const result = reviewedTrendSection(ads, new Set(["reviewed"]), tax, "2026-10-19");
  expect(result.monthly?.map((period) => period.count)).toEqual([1, 0, 0]);
  expect(funnelMarketContext(ads, new Set(["reviewed"]), true, tax, "2026-10-19")).toContain("2026-10 (partial): 0 ads");
  expect(funnelMarketContext(ads, new Set(["reviewed"]), false, tax, "2026-10-19")).toBeNull();
});

it("reports unknown-word share rises only for comparable adjacent retained periods", () => {
  const previous = saved("2026-09", { period_end: "2026-09-30" });
  const latest = { ...saved("2026-10"), unknown_words: { vibecoding: 4 } };
  expect(risingUnknownTitleWords([previous, latest], "month", "titles", "2026-11-10")).toMatchObject({ status: "available", rises: [{ word: "vibecoding", previous_count: 1, latest_count: 4 }] });
  expect(risingUnknownTitleWords([saved("2026-08"), latest], "month", "titles", "2026-11-10").reason).toBe("period_gap");
  expect(risingUnknownTitleWords([previous, { ...latest, info: { ...latest.info, sampled: true } }], "month", "titles", "2026-11-10").reason).toBe("sampled_coverage");
});
