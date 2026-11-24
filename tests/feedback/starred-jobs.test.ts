import { Either } from "effect";
import { expect, test } from "vitest";
import example from "../../contracts/fixtures/starred_jobs_api.example.json";
import { buildStarredJobsResponse, type StarredJobsInput } from "../../src/lib/server/feedback/starred-jobs.ts";
import oracle from "../oracle/viewer-api/viewer/starred-export.json";

const listing = "00000000-0000-0000-0000-000000000001";
const instant = "2026-10-19T12:00:00+00:00";
const profile = "invented";
const star = { listing_id: listing, starred: 1n, reaction: null, updated_at: instant } as const;

const details = {
  title: "Software developer", employer: "Invented Works", deadline: null,
  expires_at: "2099-01-01T00:00:00+00:00", source_status: "unknown",
  source_version: "2026-10-19T10:00:00+00:00", source_checked_at: null,
} as const;

const metadata = { schema_version: 1, profile_id: profile, jobs: [{ listing_id: listing, summary: details }] } as const;
const snapshot = { publishedAt: instant, starred: metadata };

const input: StarredJobsInput = {
  source_instance: "invented-instance", profile_id: profile, exported_at: instant, stars: [star], snapshot,
};

const decoded = (data: StarredJobsInput) => JSON.parse(new TextDecoder().decode(Either.getOrThrow(buildStarredJobsResponse(data))));
const refused = (data: StarredJobsInput) => expect(Either.isLeft(buildStarredJobsResponse(data))).toBe(true);

const withSummaries = (jobs: NonNullable<NonNullable<StarredJobsInput["snapshot"]>["starred"]>["jobs"]) =>
  ({ ...snapshot, starred: { ...metadata, jobs } });

const idOnly = (id: string, updatedAt = instant) => ({
  source: "nav", listing_id: id, starred: true, reaction: null, feedback_updated_at: updatedAt,
  url: `https://arbeidsplassen.nav.no/stillinger/stilling/${id}`, details_state: "unavailable", summary: null,
});

test("reproduces the frozen viewer-api starred response body byte for byte", () => {
  const bytes = Either.getOrThrow(buildStarredJobsResponse(input));

  expect(Buffer.from(bytes).toString("hex")).toBe(oracle.response.body.$bytes_hex);
});

test("matches the external contract fixture and includes an older star not in the snapshot", () => {
  const older = "00000000-0000-4000-8000-000000000002";
  const fresh = "00000000-0000-4000-8000-000000000001";
  const profileId = "synthetic-owner";

  expect(decoded({
    source_instance: "synthetic-railway", profile_id: profileId, exported_at: "2026-11-10T09:00:00+00:00",
    stars: [
      { listing_id: fresh, starred: 1n, reaction: null, updated_at: "2026-11-10T08:50:00+00:00" },
      { listing_id: older, starred: 1n, reaction: "up", updated_at: "2026-11-09T12:00:00+00:00" },
    ],
    snapshot: { publishedAt: "2026-11-10T08:30:00+00:00", starred: { schema_version: 1, profile_id: profileId, jobs: [{
      listing_id: fresh, summary: {
        title: "Synthetic data role", employer: "Synthetic employer", deadline: null, expires_at: null,
        source_status: "unknown", source_version: null, source_checked_at: null,
      },
    }] } },
  })).toEqual(example);
});

test("missing, legacy or other-profile snapshots keep every star ID but supply no details or capture timestamp", () => {
  for (const selected of [null, { publishedAt: instant, starred: null }, { ...snapshot, starred: { ...metadata, profile_id: "other" } }]) {
    expect(decoded({ ...input, snapshot: selected })).toEqual({
      schema_version: 1, source_instance: input.source_instance, profile_id: profile,
      exported_at: instant, snapshot_at: null, complete: true, jobs: [idOnly(listing)],
    });
  }

  expect(decoded({ ...input, stars: [] })).toMatchObject({ complete: true, jobs: [] });
});

test("withholds closed, expired and exactly 24-hour-old summaries without dropping stars", () => {
  for (const selected of [
    withSummaries([{ listing_id: listing, summary: { ...details, source_status: "closed" } }]),
    withSummaries([{ listing_id: listing, summary: { ...details, expires_at: instant } }]),
    { ...snapshot, publishedAt: "2026-10-18T12:00:00+00:00" },
  ]) {
    expect(decoded({ ...input, snapshot: selected })).toMatchObject({
      snapshot_at: selected.publishedAt, complete: true, jobs: [idOnly(listing)],
    });
  }

  expect(decoded({ ...input, snapshot: { ...snapshot, publishedAt: "2026-10-18T12:00:01+00:00" } })).toMatchObject({
    jobs: [{ details_state: "available", summary: details }],
  });
});

test("refuses corrupt metadata and future provenance even when it would not provide details", () => {
  const later = "2026-10-19T12:00:01+00:00";
  refused({ ...input, snapshot: { ...snapshot, publishedAt: later } });
  refused({ ...input, stars: [{ ...star, updated_at: later }] });
  refused({ ...input, snapshot: { publishedAt: "2026-02-30T12:00:00+00:00", starred: null } });
  refused({ ...input, snapshot: withSummaries([
    { listing_id: listing, summary: details },
    { listing_id: "z-unstarred", summary: { ...details, source_checked_at: later } },
  ]) });

  for (const title of ["", "text\u0000control", "text\u202eformat", "\ud800", "x".repeat(513)]) {
    const selected = withSummaries([{ listing_id: listing, summary: { ...details, title } }]);
    refused({ ...input, snapshot: { ...selected, starred: { ...selected.starred, profile_id: "other" } } });
  }

  const extra = { ...details, ad_text: "not part of the contract" };
  refused({ ...input, snapshot: withSummaries([{ listing_id: listing, summary: extra }]) });
});

test("rejects duplicate or out-of-order stars and metadata instead of hiding invalid input", () => {
  const later = "z-last";
  refused({ ...input, stars: [star, star] });
  refused({ ...input, stars: [{ ...star, listing_id: later }, star] });
  refused({ ...input, snapshot: withSummaries([metadata.jobs[0], metadata.jobs[0]]) });
  refused({ ...input, snapshot: withSummaries([{ listing_id: later, summary: details }, metadata.jobs[0]]) });
});

test("bounds star count, compact metadata bytes and response bytes without truncating", () => {
  const id = (index: number) => `invented-${String(index).padStart(4, "0")}`;
  const stars = Array.from({ length: 1001 }, (_, index) => ({ ...star, listing_id: id(index) }));
  refused({ ...input, stars, snapshot: null });
  expect(decoded({ ...input, stars: stars.slice(0, 1000), snapshot: null }).jobs).toHaveLength(1000);

  const large = { ...details, title: "😀".repeat(445) };
  const capture = withSummaries(stars.slice(0, 1000).map(({ listing_id }) => ({ listing_id, summary: large })));
  expect(Buffer.byteLength(JSON.stringify(capture.starred))).toBeLessThan(2 * 1024 * 1024);
  expect(Either.isRight(buildStarredJobsResponse({ ...input, snapshot: capture, stars: [] }))).toBe(true);
  refused({ ...input, snapshot: capture, stars: stars.slice(0, 1000) });

  const oversized = withSummaries(Array.from({ length: 1200 }, (_, index) => ({ listing_id: id(index), summary: large })));
  expect(Buffer.byteLength(JSON.stringify(oversized.starred))).toBeGreaterThan(2 * 1024 * 1024);
  refused({ ...input, snapshot: oversized, stars: [] });
});
