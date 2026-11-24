import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../src/lib/server/snapshot/core.ts";
import type { SnapshotCandidate, SnapshotInputs } from "../../src/lib/server/snapshot/inputs.ts";

const ids = {
  a: "00000000-0000-4000-8000-000000000001", b: "00000000-0000-4000-8000-000000000002",
  c: "00000000-0000-4000-8000-000000000003", d: "00000000-0000-4000-8000-000000000004",
  excluded: "00000000-0000-4000-8000-000000000005",
};

const titles = { a: "Data engineer", b: "Software developer", c: "Database administrator", d: "Platform engineer", excluded: "Systems analyst" };

const candidate = (key: keyof typeof ids, fit: string | null, lifecycle = "saved_source_unconfirmed"): SnapshotCandidate => ({
  listing_id: ids[key], lifecycle_status: lifecycle, title: titles[key], employer: "Invented Software AS", locations: ["Oslo"], url: `https://arbeidsplassen.nav.no/stillinger/stilling/${ids[key]}`,
  application_due: null, expires_at: null, source_version: "2026-10-19T10:00:00+00:00", full_review_result_id: null,
  full_review: fit === null ? null : { fit, reason: "reason", evidence: ["evidence"], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true },
});

const inputs = (): SnapshotInputs => ({
  now: "2026-10-19T14:00:00+02:00", profile: { id: "test", mode: "active" },
  funnel: { verified: true, listingIds: new Set([ids.a, ids.b, ids.c, ids.d]) },
  judge: { checked_at: "2026-10-19T12:00:00+00:00", eligible_count: 9, pending_count: 2, screened_out_count: 3, failed_count: 1,
    ranked: [candidate("b", "strong"), candidate("a", "exceptional"), candidate("d", null), candidate("excluded", "exceptional")],
    closed: [candidate("c", "exceptional", "confirmed_closed")], firstFound: { [ids.a]: "2026-10-19T12:00:00+00:00" } },
  market: { snapshots: [], taxonomy: { version: "disabled", enabled: false, text_min_hits: 2, families: [], terms: [], title_exclusions: [] }, ads: [], salaries: [] },
});

describe("snapshot export", () => {
  it("filters the funnel, retains ordering and fallback, and selects only open jobs", () => {
    const result = buildSnapshot(inputs());
    expect(Either.isRight(result)).toBe(true);

    if (Either.isLeft(result)) throw result.left;
    const snapshot = result.right;
    expect(snapshot.generated_at).toBe("2026-10-19T12:00:00+00:00");
    expect(snapshot.jobs.map((job) => [job.id, job.status])).toEqual([[ids.b, "open"], [ids.a, "open"], [ids.d, "open"], [ids.c, "closed"]]);
    expect(snapshot.jobs[1]?.reviewed_at).toBe("2026-10-19T12:00:00+00:00");
    expect(snapshot.jobs[2]?.assessment).toEqual({ fit: "unknown", reason: "No saved full review is available.", evidence: [], uncertainties: [], hard_constraints: "unknown", ad_text_reviewed: false });
    expect(snapshot.shortlist.job_ids).toEqual([ids.a, ids.b]);
    expect(snapshot.counts).toEqual({ eligible: 9, reviewed: 4, open: 3, closed: 1, pending: 2, screened_out: 3, failed: 1 });
  });
  it("validates generated assessments and duplicate job IDs at the contract boundary", () => {
    const base = inputs();
    expect(Either.isLeft(buildSnapshot({ ...base, judge: { ...base.judge, ranked: [candidate("a", "invented-fit")] } }))).toBe(true);
    expect(Either.isLeft(buildSnapshot({ ...base, judge: { ...base.judge, ranked: [candidate("a", "strong"), candidate("a", "strong")] } }))).toBe(true);
  });
  it("rejects unverified funnels and timezone-free times", () => {
    const base = inputs();
    expect(Either.isLeft(buildSnapshot({ ...base, funnel: { ...base.funnel, verified: false } }))).toBe(true);
    expect(Either.isLeft(buildSnapshot({ ...base, now: "2026-10-19T12:00:00" }))).toBe(true);
  });
});
