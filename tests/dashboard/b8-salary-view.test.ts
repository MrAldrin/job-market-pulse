import { expect, test } from "vitest";
import { projectSalary } from "../../src/lib/dashboard/salary-view.ts";
import { decodeB8Fixture, savedJob } from "./b8-market-salary-projection-fixture.ts";

test("uses saved salary values, flags and dates, and link targets without restoring closed labels", () => {
  const numeric = {
    job_id: savedJob.id, title: null, employer: null, month: "2026-05", changed: "2026-05-09 08:30", form: "range" as const,
    low: 55000, high: 65000, period: "month" as const, period_inferred: true, sko_code: null, ltr_min: null, ltr_max: null,
    yearly_midpoint: 720000, sko_or_vague: false, closed: true, outside_plausible_range: false,
  };

  const vague = { ...numeric, job_id: "vague-job", month: "2026-06", changed: "2026-06-04 11:00", form: "vague" as const, low: null, high: null,
    period: null, period_inferred: false, yearly_midpoint: null, sko_code: "1364", sko_or_vague: true, closed: false };

  const monthly = [{ month: "2026-05", facts: 1, numeric: 1, median_yearly: null, sko_or_vague: 0 },
    { month: "2026-06", facts: 1, numeric: 0, median_yearly: null, sko_or_vague: 1 },
    { month: "2026-07", facts: 5, numeric: 5, median_yearly: 740000, sko_or_vague: 0 },
    { month: "2026-09", facts: 5, numeric: 5, median_yearly: 730000, sko_or_vague: 0 },
    { month: "2026-10", facts: 5, numeric: 5, median_yearly: 780000, sko_or_vague: 0 }];

  const annualFacts = monthly.slice(2).flatMap(({ month, median_yearly }) => Array.from({ length: 5 }, (_, index) => ({
    ...numeric, job_id: `${month}-${index}`, month, changed: `${month}-15 12:00`, form: "single" as const,
    low: median_yearly, high: median_yearly, period: "year" as const, period_inferred: false, yearly_midpoint: median_yearly,
  })));

  const ads = [numeric, vague, ...annualFacts];

  const jobs = ads.map((fact) => ({ ...savedJob, id: fact.job_id, status: fact.closed ? "closed" as const : "open" as const,
    url: `https://example.test/${fact.job_id}` }));

  const view = projectSalary(decodeB8Fixture({ jobs, salary: { ads, monthly, undated: 2 } }));

  expect(view.state).toBe("saved");

  if (view.state !== "saved") throw new Error("Expected saved salary facts");
  expect(view.ads.slice(0, 2)).toEqual([
    { fact: numeric, jobLink: { id: savedJob.id, sourceUrl: savedJob.url } },
    { fact: vague, jobLink: { id: vague.job_id, sourceUrl: "https://example.test/vague-job" } },
  ]);
  expect(view.monthly).toEqual(monthly.map((month, index) => ({
    ...month, hidden: index < 2, connectsToPrevious: index === 4,
    stats: month.median_yearly === null ? null : { low: month.median_yearly, high: month.median_yearly, mean: month.median_yearly },
  })));

  const incomplete = projectSalary(decodeB8Fixture({ jobs, salary: { ads: ads.slice(0, -1), monthly, undated: 2 } }));

  expect(incomplete).toMatchObject({ monthly: expect.arrayContaining([
    expect.objectContaining({ month: "2026-10", median_yearly: 780000, stats: null }),
  ]) });

  const malformed = projectSalary(decodeB8Fixture({ jobs, salary: { monthly, undated: 0,
    ads: ads.map((fact, index) => index === ads.length - 1 ? { ...fact, low: null } : fact) } }));

  expect(malformed).toMatchObject({ monthly: expect.arrayContaining([
    expect.objectContaining({ month: "2026-10", median_yearly: 780000, stats: null }),
  ]) });

  const mismatch = projectSalary(decodeB8Fixture({ jobs, salary: { ads, undated: 0,
    monthly: monthly.slice(2, 4).map((month, index) => index === 0
      ? { ...month, median_yearly: 750000 } : { ...month, numeric: 4 }) } }));

  expect(mismatch).toMatchObject({ monthly: [
    { median_yearly: 750000, stats: null, hidden: false },
    { median_yearly: null, stats: null, hidden: true },
  ] });
  expect(view.undated).toBe(2);
});

test("keeps unavailable, empty and undated-only salary sections distinct", () => {
  expect(projectSalary(decodeB8Fixture())).toEqual({ state: "unavailable" });
  expect(projectSalary(decodeB8Fixture({ salary: { ads: [], monthly: [], undated: 0 } }))).toEqual({ state: "empty", ads: [], monthly: [], undated: 0 });
  expect(projectSalary(decodeB8Fixture({ salary: { ads: [], monthly: [], undated: 2 } }))).toEqual({ state: "saved", ads: [], monthly: [], undated: 2 });
});
