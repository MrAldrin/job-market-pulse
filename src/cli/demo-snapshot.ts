import type { Snapshot, SnapshotV6 } from "../lib/contracts/snapshot.ts";
import { dayMillis, dayText, periodBounds, periodLabel } from "../lib/server/market/periods.ts";

const reviewer = { harness: "pi", provider: null, model: null, effort: "low", batch_size: 1 } as const;

// Follow the fixture's job order. The shortlist shows all four distance styles.
const distances = [18, 6, 27, 8, null, 26, 14, 17, 10, 5, null, 21];
const jobAges = [7, 2, 14, 10, 8, 4, 6, 5, 4, 3, 2, 1];

const monthAt = (now: Date, offset: number): string =>
  dayText(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).slice(0, 7);

export const demoSnapshot = (example: Snapshot, nowMs: number): SnapshotV6 => {
  const now = new Date(nowMs);
  const timestamp = now.toISOString();
  const ago = (days: number) => new Date(nowMs - days * dayMillis).toISOString();
  const thisMonth = monthAt(now, 0);
  const lastWeek = periodLabel("week", dayText(nowMs - 7 * dayMillis));
  const weekStart = periodBounds("week", lastWeek)?.[0];
  const market = example.market;

  // Five eligible ads per month keep the demo statistics visible.
  const salaryMonths = [
    { month: monthAt(now, -2), midpoints: [580_000, 610_000, 640_000, 675_000, 695_000] },
    { month: monthAt(now, -1), midpoints: [600_000, 630_000, 680_000, 715_000, 750_000] },
  ];

  const salaryAds = salaryMonths.flatMap(({ month, midpoints }, group) =>
    midpoints.flatMap((midpoint, index) => {
      const job = example.jobs[group * midpoints.length + index];

      return job === undefined ? [] : [{
        job_id: job.id, title: job.title, employer: job.employer, month, changed: `${month}-12 12:00`,
        form: "range" as const, low: midpoint - 25_000, high: midpoint + 25_000, period: "year" as const,
        period_inferred: false, sko_code: null, ltr_min: null, ltr_max: null, yearly_midpoint: midpoint,
        sko_or_vague: false, closed: job.status === "closed", outside_plausible_range: false,
      }];
    }));

  const salaryByJob = new Map(salaryAds.map((ad) => [ad.job_id, ad.month]));

  return {
    ...example, schema_version: 6, generated_at: timestamp,
    source: { ...example.source, checked_at: timestamp },
    jobs: example.jobs.map((job, index) => {
      const found = ago(jobAges[index] ?? 2);
      const salaryMonth = salaryByJob.get(job.id);

      return {
        ...job, source_version: salaryMonth === undefined ? found : `${salaryMonth}-12T12:00:00.000Z`,
        first_found_at: job.first_found_at === null ? null : found,
        reviewed_at: job.reviewed_at === null ? null : found,
        expires_at: job.expires_at === null ? null : ago(1), distance_km: distances[index] ?? null,
      };
    }),
    market: market === null ? null : {
      ...market, captured_at: timestamp, weekly: null,
      monthly: {
        ...market.monthly,
        periods: market.monthly.periods.map((period, index, periods) => {
          const label = monthAt(now, index + 1 - periods.length);
          const bounds = periodBounds("month", label);

          return period.coverage === "missing" ? { ...period, label } : {
            ...period, label, start: bounds?.[0] ?? null, end: bounds?.[1] ?? null, captured_at: timestamp,
          };
        }),
      },
    },
    reviewed_trend: example.reviewed_trend === null ? null : {
      weekly: weekStart === undefined ? [] : [{ label: lastWeek, start: weekStart, count: 1 }],
      monthly: [{ label: thisMonth, start: `${thisMonth}-01`, count: 1 }],
    },
    salary: {
      ads: salaryAds, undated: 0,
      monthly: salaryMonths.map(({ month, midpoints }) => {
        const count = salaryAds.filter((ad) => ad.month === month).length;

        return { month, facts: count, numeric: count, median_yearly: count === 5 ? midpoints[2] ?? null : null, sko_or_vague: 0 };
      }),
    },
    settings: {
      policy: { market_only: false, freshness_max_age_hours: 36 },
      filters: {
        radius_km: 30, preferred_municipalities: null, nearby_municipalities: null, excluded_municipalities: [],
        allowed_occupation_categories: ["IT"], excluded_title_terms: [], excluded_employers: [], preferred_terms: [],
      },
      title_screen: { academic: [], business_development: [], sales: [], tech_words: [] },
      sources: { name: "nav", excludes_finn: true },
      review: { screen: reviewer, judge: reviewer, rejudge: reviewer, calibrate: reviewer },
      schedule: { kind: "never", timezone: "Europe/Oslo" },
    },
    personal_inputs: {
      home_location: { label: null, home_postcode: null, area_postcode: null, origin: null },
      narrative: "Fictional profile for the dashboard demo.",
    },
    run_funnel: null,
  };
};
