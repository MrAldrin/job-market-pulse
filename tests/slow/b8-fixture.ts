import { Either } from "effect";
import { decodeSnapshotBytes, decodeSnapshotDocumentBytes, type Snapshot, type SnapshotV2 } from "../../src/lib/contracts/snapshot.ts";

const weeks = [
  { label: "week-2025-W49", start: "2025-12-01", end: "2025-12-07", stock: 20, sql: 2 },
  { label: "week-2025-W50", start: "2025-12-08", end: "2025-12-14", stock: 21, sql: 0 },
  { label: "week-2025-W52", start: "2025-12-22", end: "2025-12-28", stock: 7, sql: 4 },
] as const;

type MarketPoint = NonNullable<SnapshotV2["market_history"]>[number];

function stockPoint(profileId: string, week: typeof weeks[number], series: "titles" | "detailed"): MarketPoint {
  const detail = series === "detailed";
  const population = detail ? 5 : week.stock;

  return {
    label: detail ? `detail-${week.label}` : week.label,
    basis: detail ? "titles+text" : "titles", period_start: week.start, period_end: week.end,
    sampled: false, ad_count: population, taxonomy_version: "synthetic-v1", captured_at: `${week.end}T10:00:00+01:00`,
    counts: { families: { data: 5 }, terms: { sql: week.sql }, tech_terms: { sql: week.sql } },
    origin: "recorded",
    metadata: {
      profile_id: profileId, series, capture_week: week.label, timezone: "Europe/Oslo", membership: "current_unexpired_stock",
      classifier_engine: "native_js_known_ab_v1", filter_fingerprint: detail ? "a".repeat(64) : null,
      population, text_coverage: detail ? 3 : 0, occupation_coverage: detail ? 2 : 0,
    },
  };
}

function salarySample(base: Snapshot): NonNullable<SnapshotV2["salary"]> {
  const salary = base.salary;

  if (!salary) throw new Error("Expected the synthetic v1 salary sample");
  const known = new Set(salary.ads.map((fact) => fact.job_id));
  const jobs = base.jobs.filter((job) => job.status === "open" && !known.has(job.id));
  const months = [{ month: "2025-11", median_yearly: 720_000 }, { month: "2025-09", median_yearly: 760_000 }];

  if (jobs.length < 10) throw new Error("Expected ten more synthetic jobs");

  const added = months.flatMap(({ month, median_yearly }, index) => jobs.slice(index * 5, (index + 1) * 5).map((job, offset) => {
    const amount = median_yearly + (offset === 4 ? 50_000 : (offset - 2) * 10_000);

    return {
      job_id: job.id, title: job.title, employer: job.employer, month, changed: `${month}-15 12:00`,
      form: "single" as const, low: amount, high: null, period: "year" as const, period_inferred: false,
      sko_code: null, ltr_min: null, ltr_max: null, yearly_midpoint: amount,
      sko_or_vague: false, closed: false, outside_plausible_range: false,
    };
  }));

  return {
    ads: [...added, ...salary.ads], undated: salary.undated,
    monthly: [
      ...months.map((month) => ({ ...month, facts: 5, numeric: 5, sko_or_vague: 0 })),
      { month: "2025-10", facts: 0, numeric: 0, sko_or_vague: 0, median_yearly: null },
      ...salary.monthly,
    ].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

export function b8SnapshotBytes(v1Bytes: Uint8Array): Uint8Array {
  const base = Either.getOrThrow(decodeSnapshotBytes(v1Bytes));

  const snapshot: SnapshotV2 = {
    ...base, schema_version: 2, salary: salarySample(base),
    market_history: weeks.flatMap((week) => [stockPoint(base.profile.id, week, "titles"), stockPoint(base.profile.id, week, "detailed")]),
  };

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));

  Either.getOrThrow(decodeSnapshotDocumentBytes(bytes));

  return bytes;
}
