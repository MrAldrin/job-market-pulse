import fc from "fast-check";
import { expect, test } from "vitest";
import type { SnapshotV2 } from "../../src/lib/contracts/snapshot.ts";
import { frozenReadings, historyReadings, projectMarket, reviewedReadings } from "../../src/lib/dashboard/market-view.ts";
import { decodeB8Fixture, frozenMarket } from "./b8-market-salary-projection-fixture.ts";

const reviewed = { monthly: [{ label: "2026-08", start: "2026-08-01", count: 2 }, { label: "2026-10", start: "2026-10-01", count: 0 }], weekly: [] };

test("keeps frozen v1 monthly and weekly values, term populations and reviewed first-seen separate", () => {
  const view = projectMarket(decodeB8Fixture({ market: frozenMarket, reviewed_trend: reviewed }));

  expect(view.history).toBeNull();
  expect(view.frozen).toEqual(frozenMarket);
  expect(view.reviewedFirstSeen).toEqual(reviewed);

  if (!view.frozen || !view.reviewedFirstSeen) throw new Error("Expected both saved sections");

  const monthly = view.frozen.monthly;
  const family = frozenReadings(monthly, "monthly", { kind: "families", key: "data" });

  expect(family.map(({ value, connectsToPrevious }) => [value, connectsToPrevious])).toEqual([[8, false], [0, true], [null, false], [4, false], [5, false]]);
  expect(view.frozen.weekly && frozenReadings(view.frozen.weekly, "weekly", { kind: "ad_count" })[0]).toMatchObject({
    value: 3, connectsToPrevious: false, period: { coverage: "partial", sampled: true },
  });
  expect(frozenReadings(monthly, "monthly", { kind: "terms", key: "sql" }).map((row) => row.value)).toEqual([3, 0, null, null, 4]);
  expect(frozenReadings(monthly, "monthly", { kind: "tech_terms", key: "sql" }).map((row) => row.value)).toEqual([2, 0, null, null, 1]);
  expect(reviewedReadings(view.reviewedFirstSeen, "monthly").map(({ value, connectsToPrevious }) => [value, connectsToPrevious])).toEqual([[2, false], [0, false]]);
});

type Point = NonNullable<SnapshotV2["market_history"]>[number];

const recorded = (week: number, start: string, detailed: boolean, fingerprint: string): Point => {
  const capture_week = `week-2026-W${week}`;

  return {
    label: detailed ? `detail-${capture_week}` : capture_week, basis: detailed ? "titles+text" : "titles", period_start: start,
    period_end: null, sampled: false, ad_count: detailed ? 4 : 20, taxonomy_version: "demo-2", captured_at: `${start}T12:00:00+01:00`,
    counts: { families: { data: 2 }, terms: { sql: 0 }, tech_terms: {} }, origin: "recorded",
    metadata: {
      series: detailed ? "detailed" : "titles", capture_week, profile_id: "demo", timezone: "Europe/Oslo",
      membership: "current_unexpired_stock", classifier_engine: "native_js_known_ab_v1", filter_fingerprint: detailed ? fingerprint : null,
      population: detailed ? 4 : 20, text_coverage: detailed ? 3 : 0, occupation_coverage: detailed ? 1 : 0,
    },
  };
};

const frozen: Point = {
  label: "2026-09", basis: "titles", period_start: "2026-09-01", period_end: null, sampled: false,
  ad_count: 5, taxonomy_version: "demo-2", captured_at: frozenMarket.captured_at,
  counts: { families: { data: 5 }, terms: { sql: 4 }, tech_terms: { sql: 1 } }, origin: "frozen_history", metadata: null,
};

test("suppresses only equivalent frozen titles observations and preserves the legacy reading", () => {
  const august = { ...frozen, label: "2026-08", period_start: "2026-08-01", ad_count: 4, taxonomy_version: "demo-1",
    counts: { families: { data: 4 }, terms: {}, tech_terms: {} } };

  const extras = [
    { ...august, counts: { ...august.counts, terms: { sql: 0 } } },
    { ...frozen, ad_count: 6 },
    { ...frozen, counts: { ...frozen.counts, terms: { sql: 0 } } },
    { ...frozen, counts: { ...frozen.counts, tech_terms: {} } },
    { ...frozen, counts: { ...frozen.counts, terms: { sql: 4, python: 0 } } },
    { ...frozen, captured_at: "2026-11-17T09:00:00+01:00" },
  ];

  const view = projectMarket(decodeB8Fixture({ schema_version: 2, market: frozenMarket, market_history: [frozen, august, ...extras] }));

  expect(view.frozen).toEqual(frozenMarket);
  expect(view.history?.frozenTitles.monthly).toHaveLength(extras.length);
  expect(view.history?.frozenTitles.monthly.map((row) => [row.period.ad_count, row.counts, row.period.captured_at]))
    .toEqual(extras.map((point) => [point.ad_count, point.counts, point.captured_at]));
});

test("a frozen month cannot be replaced by a matching legacy row under weekly", () => {
  const market = { ...frozenMarket, monthly: { periods: [], families: [], terms: [] }, weekly: frozenMarket.monthly };
  const { history } = projectMarket(decodeB8Fixture({ schema_version: 2, market, market_history: [frozen] }));

  expect(history?.frozenTitles.monthly.map((row) => row.period.label)).toEqual([frozen.label]);
  expect(history?.frozenTitles.weekly).toEqual([]);
});

test("sorts interleaved frozen cadences and reversed recorded weeks without mutating the input", () => {
  const detail = recorded(44, "2026-10-26", true, "a".repeat(64));
  const next = recorded(45, "2026-11-02", true, "b".repeat(64));
  const gap = recorded(47, "2026-11-16", true, "c".repeat(64));
  const week = (label: string, period_start: string | null) => ({ ...frozen, label, period_start });

  const saved = [gap, { ...recorded(45, "2026-11-02", false, ""), taxonomy_version: "demo-3" },
    { ...next, metadata: next.metadata && { ...next.metadata, text_coverage: 1, occupation_coverage: 2 } }, detail,
    recorded(44, "2026-10-26", false, ""), frozen, week("week-2021-W01", null),
    { ...frozen, label: "2026-08", period_start: "2026-11-01" }, week("week-2020-W53", "2026-11-02"),
    week("week-2021-W53", "2021-12-27"), { ...frozen, basis: "titles+text" as const }, { ...frozen, label: "undated sample" }];

  const snapshot = decodeB8Fixture({ schema_version: 2, market_history: saved });
  const { history } = projectMarket(snapshot);

  if (!history || snapshot.schema_version !== 2) throw new Error("Expected v2 history");
  expect(snapshot.market_history).toEqual(saved);
  expect(history.frozenTitles.monthly.map((row) => row.period.label)).toEqual(["2026-08", "2026-09"]);
  expect(historyReadings(history.frozenTitles.monthly, "ad_count").map((row) => row.connectsToPrevious)).toEqual([false, true]);
  expect(history.frozenTitles.weekly.map((row) => row.period.label)).toEqual(["week-2020-W53", "week-2021-W01"]);
  expect(historyReadings(history.frozenTitles.weekly, "ad_count").map((row) => row.connectsToPrevious)).toEqual([false, true]);
  expect(history.frozenTitles.other.map((row) => row.period.label)).toEqual(["week-2021-W53", "undated sample"]);
  expect(history.frozenTitlesAndText.monthly[0]).toMatchObject({ origin: "frozen_history", capture: null });
  expect(historyReadings(history.recordedTitles.weekly, "ad_count").map(({ value, connectsToPrevious }) => [value, connectsToPrevious])).toEqual([[20, false], [20, false]]);
  const detailed = history.recordedDetailed.weekly;

  expect(detailed.map((row) => row.capture.textCoverage)).toEqual([{ covered: 3, population: 4 }, { covered: 1, population: 4 }, { covered: 3, population: 4 }]);
  expect(detailed.map((row) => row.capture.occupationCoverage)).toEqual([{ covered: 1, population: 4 }, { covered: 2, population: 4 }, { covered: 1, population: 4 }]);
  expect(historyReadings(detailed, { kind: "terms", key: "sql" }).map(({ value, connectsToPrevious }) => [value, connectsToPrevious])).toEqual([[0, false], [0, true], [0, false]]);
  expect(historyReadings(detailed, { kind: "tech_terms", key: "sql" }).map((row) => row.value)).toEqual([null, null, null]);
  expect(JSON.stringify(history)).not.toMatch(/fingerprint|complete|a{64}/);
});

test("an unrecognized recorded week keeps its value without splitting the calendar sequence", () => {
  const first = recorded(44, "2026-10-26", false, "");
  const second = recorded(45, "2026-11-02", false, "");
  const label = "week-2026-W44-extra";
  const other = { ...first, label, metadata: first.metadata && { ...first.metadata, capture_week: label } };
  const { history } = projectMarket(decodeB8Fixture({ schema_version: 2, market_history: [second, other, first] }));

  if (!history) throw new Error("Expected v2 history");
  const { weekly, other: unrecognized } = history.recordedTitles;

  expect(historyReadings(weekly, "ad_count").map(({ period, connectsToPrevious }) => [period.period.label, connectsToPrevious]))
    .toEqual([[first.label, false], [second.label, true]]);
  expect(historyReadings(unrecognized, "ad_count")[0]).toMatchObject({ value: other.ad_count, period: { period: { label } } });
});

test("derives v1 frozen weekly rollover from ISO labels and preserves declared saved dates", () => {
  const saved = frozenMarket.weekly?.periods[0];

  if (!saved) throw new Error("Expected a saved period");

  const weekly = { families: [], terms: [], periods: [
    { ...saved, label: "week-2020-W53", start: null, end: null },
    { ...saved, label: "week-2021-W01", start: "2026-11-02" },
    { ...saved, label: "week-2021-W03", start: "2026-11-09" },
    { ...saved, label: "week-2021-W53", start: "2021-12-27" },
    { ...saved, label: "week-2022-W01", start: "2022-01-03" },
  ] };

  const view = projectMarket(decodeB8Fixture({ market: { ...frozenMarket, weekly } }));

  if (!view.frozen?.weekly) throw new Error("Expected saved weekly history");

  const rows = frozenReadings(view.frozen.weekly, "weekly", { kind: "ad_count" });

  expect(rows.map((row) => row.connectsToPrevious)).toEqual([false, true, false, false, false]);
  expect(rows.map((row) => row.period)).toEqual(weekly.periods);
});

test("distinguishes absent v2 history and empty saved sections", () => {
  const emptyFrozen = { monthly: [], weekly: [], other: [] };

  expect(projectMarket(decodeB8Fixture({ schema_version: 2, market_history: null }))).toEqual({ frozen: null, reviewedFirstSeen: null, history: null });
  expect(projectMarket(decodeB8Fixture({ schema_version: 2, market_history: [] })).history).toEqual({
    frozenTitles: emptyFrozen, frozenTitlesAndText: emptyFrozen,
    recordedTitles: { weekly: [], other: [] }, recordedDetailed: { weekly: [], other: [] },
  });
});

test("quiet fingerprints never alter an otherwise identical projection", () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), (n) => {
    const project = (fingerprint: string) => projectMarket(decodeB8Fixture({ schema_version: 2,
      market_history: [recorded(44, "2026-10-26", true, fingerprint)] }));

    expect(project(n.toString(16).padStart(64, "0"))).toEqual(project("0".repeat(64)));
  }));
});
