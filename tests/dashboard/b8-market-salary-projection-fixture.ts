import { Either } from "effect";
import { decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import type { SnapshotV2 } from "../../src/lib/contracts/snapshot.ts";

const capturedAt = "2026-11-16T09:00:00+01:00";

export const savedJob: SnapshotV2["jobs"][number] = {
  id: "demo-job", source: "NAV", source_version: "demo-2", title: "Data engineer", employer: "Demo employer", locations: [],
  url: "https://example.test/demo-job", expires_at: null, status: "closed", first_found_at: null, reviewed_at: null, result_id: null,
  assessment: { fit: "possible", reason: "Synthetic review", evidence: [], uncertainties: [], hard_constraints: "unknown", ad_text_reviewed: true },
};

const frozenPeriod = (label: string, version: string, count: number) => ({
  label, start: `${label}-01`, end: null, partial: false, ad_count: count, tech_total: count, sampled: false,
  taxonomy_version: version, captured_at: capturedAt, coverage: "closed" as const,
});

const missingPeriod = (label: string) => ({
  label, start: null, end: null, partial: null, ad_count: null, tech_total: null, sampled: null,
  taxonomy_version: null, captured_at: null, coverage: "missing" as const,
});

export const frozenMarket: NonNullable<SnapshotV2["market"]> = {
  taxonomy_version: "demo-2", captured_at: capturedAt, note: "Saved NAV sample",
  monthly: {
    periods: [frozenPeriod("2026-05", "demo-1", 8), frozenPeriod("2026-06", "demo-1", 0), missingPeriod("2026-07"),
      frozenPeriod("2026-08", "demo-1", 4), frozenPeriod("2026-09", "demo-2", 5)],
    families: [{ key: "data", label: "Data", counts: [8, 0, null, 4, 5] }],
    terms: [{ key: "sql", label: "SQL", group: "data", counts: [3, 0, null, null, 4], tech_counts: [2, 0, null, null, 1] }],
  },
  weekly: {
    periods: [{ ...frozenPeriod("unused", "demo-2", 3), label: "week-2026-W44", start: "2026-10-26", end: "2026-11-01",
      partial: true, sampled: true, coverage: "partial" }], families: [], terms: [],
  },
};

export const decodeB8Fixture = (fields: Partial<Omit<SnapshotV2, "schema_version">> & { schema_version?: 1 | 2 } = {}) => Either.getOrThrow(decodeSnapshotDocumentBytes(new TextEncoder().encode(JSON.stringify({
  schema: "pulse.snapshot", schema_version: 1, generated_at: capturedAt, profile: { id: "demo", mode: "passive" },
  source: { name: "NAV", checked_at: null, coverage_note: "Synthetic sample" },
  counts: { eligible: 1, reviewed: 1, open: 0, closed: 1, pending: 0, screened_out: 0, failed: 0 },
  jobs: [], shortlist: { job_ids: [], rule: "Synthetic selection" }, market: null, reviewed_trend: null, salary: null,
  ...fields,
}))));
