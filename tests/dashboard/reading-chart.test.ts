import { expect, test } from "vitest";
import { frozenReadings, projectMarket, reviewedReadings } from "../../src/lib/dashboard/market-view.ts";
import { projectReadingChart } from "../../src/lib/dashboard/reading-chart.ts";
import { projectSalary } from "../../src/lib/dashboard/salary-view.ts";
import { decodeB8Fixture, frozenMarket } from "./b8-market-salary-projection-fixture.ts";

test("plots saved archive zeroes and leaves null, taxonomy and noncalendar breaks", () => {
  const periods = [...frozenMarket.monthly.periods];
  const lastPeriod = periods.at(-1);

  if (!lastPeriod) throw new Error("Expected archived readings");

  periods.push({ ...lastPeriod, label: "not a calendar period" });

  const market = { ...frozenMarket, monthly: { periods, families: [
    { key: "data", label: "Data", counts: [8, 0, null, 4, 5, 9] },
  ], terms: [] } };

  const view = projectMarket(decodeB8Fixture({ market }));

  if (!view.frozen) throw new Error("Expected archived readings");

  const readings = frozenReadings(view.frozen.monthly, "monthly", { kind: "families", key: "data" });
  const chart = projectReadingChart(readings, "monthly", (period) => period.label);

  expect(chart.points.map(({ label, value, segment }) => [label, value, segment])).toEqual([
    ["2026-05", 8, 0], ["2026-06", 0, 0], ["2026-08", 4, 2], ["2026-09", 5, 3],
  ]);
  expect(chart.lines.map(({ label }) => label)).toEqual(["2026-05", "2026-06"]);
  expect(readings.at(-1)?.value).toBe(9);
  expect(projectReadingChart(readings, "other", (period) => period.label)).toEqual({ points: [], lines: [], ticks: [] });
});

test("plots weekly capture dates independently of the saved detail labels and leaves an absent week blank", () => {
  const readings = [
    { period: { label: "detail-week-2026-W43", week: "week-2026-W43" }, value: 18, connectsToPrevious: false },
    { period: { label: "detail-week-2026-W44", week: "week-2026-W44" }, value: 20, connectsToPrevious: true },
    { period: { label: "detail-week-2026-W46", week: "week-2026-W46" }, value: 21, connectsToPrevious: false },
    { period: { label: "detail-week-2026-W47", week: "week-2026-W47" }, value: 19, connectsToPrevious: true },
    { period: { label: "detail-week-2026-W48", week: "week-2026-W48" }, value: 17, connectsToPrevious: true },
  ];

  const chart = projectReadingChart(readings, "weekly", (period) => period.label, (period) => period.week);

  expect(chart.points.map(({ label, time, segment }) => [label, new Date(time).toISOString().slice(0, 10), segment])).toEqual([
    ["detail-week-2026-W43", "2026-10-19", 0], ["detail-week-2026-W44", "2026-10-26", 0],
    ["detail-week-2026-W46", "2026-11-09", 2], ["detail-week-2026-W47", "2026-11-16", 2], ["detail-week-2026-W48", "2026-11-23", 2],
  ]);
  expect(chart.lines).toEqual(chart.points);
  expect(chart.ticks).toEqual([Date.UTC(2026, 9, 19), Date.UTC(2026, 10, 23)]);
});

test("keeps reviewed first-seen zeroes as standalone marks across an absent month", () => {
  const view = projectMarket(decodeB8Fixture({ reviewed_trend: { weekly: [], monthly: [
    { label: "2026-07", start: "2026-07-01", count: 2 }, { label: "2026-09", start: "2026-09-01", count: 0 },
  ] } }));

  if (!view.reviewedFirstSeen) throw new Error("Expected saved reviewed counts");

  const chart = projectReadingChart(reviewedReadings(view.reviewedFirstSeen, "monthly"), "monthly", (period) => period.label);

  expect(chart.points.map((point) => point.value)).toEqual([2, 0]);
  expect(chart.lines).toEqual([]);
});

test("plots exact saved medians without turning suppressed medians or absent months into points", () => {
  const view = projectSalary(decodeB8Fixture({ salary: { ads: [], undated: 0, monthly: [
    { month: "2026-03", facts: 3, numeric: 3, median_yearly: null, sko_or_vague: 0 },
    { month: "2026-04", facts: 5, numeric: 5, median_yearly: 645000.5, sko_or_vague: 0 },
    { month: "2026-06", facts: 5, numeric: 5, median_yearly: 710000, sko_or_vague: 0 },
    { month: "2026-07", facts: 5, numeric: 5, median_yearly: 720000, sko_or_vague: 0 },
  ] } }));

  if (view.state !== "saved") throw new Error("Expected saved monthly medians");

  const readings = view.monthly.map((month) => ({ period: month.month, value: month.median_yearly, connectsToPrevious: month.connectsToPrevious }));
  const chart = projectReadingChart(readings, "monthly", (month) => month);

  expect(chart.points.map(({ label, value }) => [label, value])).toEqual([
    ["2026-04", 645000.5], ["2026-06", 710000], ["2026-07", 720000],
  ]);
  expect(chart.lines).toEqual(chart.points.slice(1));
  expect(chart.ticks).toEqual([Date.UTC(2026, 2, 1), Date.UTC(2026, 6, 1)]);
  expect(projectReadingChart(readings.slice(0, 1), "monthly", (month) => month).points).toEqual([]);
});
