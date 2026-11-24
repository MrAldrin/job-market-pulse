import { Data, Either, Schema } from "effect";
import type { SnapshotRecord } from "../snapshot/store.ts";
import { PhoneListingId, PhoneProfileId, PhoneReaction } from "./phone-store-schema.ts";

export const MAX_STARRED_JOBS = 1000;

const maxJsonBytes = 2 * 1024 * 1024;
const summaryTtlMs = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const navJobPrefix = "https://arbeidsplassen.nav.no/stillinger/stilling/";

export const StarredInstanceId = Schema.String.pipe(Schema.maxLength(128), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/));

const utcSeconds = Schema.String.pipe(Schema.filter((stamp) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00(?![\s\S])/.test(stamp) || stamp.startsWith("0000-")) return false;
  const epoch = Date.parse(stamp);

  return Number.isFinite(epoch) && new Date(epoch).toISOString().replace(".000Z", "+00:00") === stamp;
}));

const summaryText = (maximum: number) => Schema.NullOr(Schema.String.pipe(Schema.filter((value) =>
  value.length > 0 && value.length <= maximum * 2 && Array.from(value).length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value),
)));

const summary = Schema.Struct({
  title: summaryText(512), employer: summaryText(512), deadline: summaryText(512),
  expires_at: Schema.NullOr(utcSeconds), source_status: Schema.Literal("active", "closed", "unknown"),
  source_version: summaryText(128), source_checked_at: Schema.NullOr(utcSeconds),
});

const sortedListings = <A extends { readonly listing_id: string }, I>(item: Schema.Schema<A, I>, maximum: number) =>
  Schema.compose(
    Schema.Unknown.pipe(Schema.filter((input) => Array.isArray(input) && input.length <= maximum)),
    Schema.Array(item).pipe(Schema.filter((rows) => {
      let previous = "";

      for (const { listing_id: id } of rows) {
        if (id <= previous) return false;
        previous = id;
      }

      return true;
    })),
  );

// Validate the selected structured data, not the Snapshot store or its BLOB.
const snapshot = Schema.Struct({
  publishedAt: utcSeconds,
  starred: Schema.NullOr(Schema.Struct({
    schema_version: Schema.Literal(1), profile_id: PhoneProfileId,
    jobs: sortedListings(Schema.Struct({ listing_id: PhoneListingId, summary }), 66_666),
  })),
});

const stars = sortedListings(Schema.Struct({
  listing_id: PhoneListingId, starred: Schema.Literal(1n), reaction: PhoneReaction, updated_at: utcSeconds,
}), MAX_STARRED_JOBS);

const input = Schema.Struct({
  source_instance: StarredInstanceId, profile_id: PhoneProfileId, exported_at: utcSeconds,
  stars, snapshot: Schema.NullOr(snapshot),
});

export interface StarredJobsInput extends Omit<typeof input.Type, "snapshot"> {
  readonly snapshot: Pick<SnapshotRecord, "publishedAt" | "starred"> | null;
}

export class StarredJobsError extends Data.TaggedError("StarredJobsError")<{ readonly message: string }> {}

const unavailable = () => new StarredJobsError({ message: "Starred-jobs source is unavailable" });
const decode = Schema.decodeUnknownEither(input, { onExcessProperty: "error", exact: true });

const captureSummaries = (capture: typeof snapshot.Type | null, profileId: string, exportedAt: string) => Either.gen(function* () {
  const summaries = new Map<string, typeof summary.Type>();

  if (capture === null || capture.starred === null) return { stamp: null, summaries };
  const { publishedAt, starred } = capture;
  const matchesProfile = starred.profile_id === profileId;
  const fresh = Date.parse(exportedAt) - Date.parse(publishedAt) < summaryTtlMs;
  // Enforce the compact size bound incrementally without allocating an oversized blob.
  let bytes = encoder.encode(JSON.stringify({ ...starred, jobs: [] })).byteLength;

  for (const [index, job] of starred.jobs.entries()) {
    const details = job.summary;
    bytes += encoder.encode(JSON.stringify(job)).byteLength + (index === 0 ? 0 : 1);

    if (bytes > maxJsonBytes || (details.source_checked_at !== null && details.source_checked_at > publishedAt)) {
      return yield* Either.left(unavailable());
    }

    if (matchesProfile && fresh && details.source_status !== "closed" && (details.expires_at === null || details.expires_at > exportedAt)) {
      summaries.set(job.listing_id, details);
    }
  }

  if (matchesProfile && publishedAt > exportedAt) return yield* Either.left(unavailable());

  return { stamp: matchesProfile ? publishedAt : null, summaries };
});

/** Project the complete ordered star set for one profile. This does not select or open either store. */
export const buildStarredJobsResponse = (selected: StarredJobsInput) => Either.gen(function* () {
  const value = yield* Either.mapLeft(decode(selected), unavailable);
  const capture = yield* captureSummaries(value.snapshot, value.profile_id, value.exported_at);
  const jobs = [];

  for (const row of value.stars) {
    if (row.updated_at > value.exported_at) return yield* Either.left(unavailable());
    const details = capture.summaries.get(row.listing_id) ?? null;

    jobs.push({
      source: "nav", listing_id: row.listing_id, starred: true, reaction: row.reaction,
      feedback_updated_at: row.updated_at, url: navJobPrefix + row.listing_id,
      details_state: details === null ? "unavailable" : "available", summary: details,
    });
  }

  const bytes = encoder.encode(JSON.stringify({
    schema_version: 1, source_instance: value.source_instance, profile_id: value.profile_id,
    exported_at: value.exported_at, snapshot_at: capture.stamp, complete: true, jobs,
  }));

  return bytes.byteLength <= maxJsonBytes ? bytes : yield* Either.left(unavailable());
});
