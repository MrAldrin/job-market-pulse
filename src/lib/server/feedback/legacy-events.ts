import { Data, Effect, Either, Schema } from "effect";
import { decodeFeedbackEvents, MAX_FEEDBACK_EVENTS } from "../../contracts/feedback-events.ts";
import { ProfileId } from "../../contracts/profile.ts";
import type { SqliteResource } from "../shared/sqlite-resource.ts";
import { strip } from "../shared/text.ts";
import { readSelectedFeedbackFile } from "./read-selected.ts";

export class LegacyFeedbackError extends Data.TaggedError("LegacyFeedbackError")<{ readonly message: string }> {}

const unavailable = () => new LegacyFeedbackError({ message: "Legacy feedback cannot be read" });
const isProfileId = Schema.is(ProfileId);
const isRowId = Schema.is(Schema.BigIntFromSelf);

interface LegacyRow {
  readonly id: unknown;
  readonly ad_id: unknown;
  readonly source: unknown;
  readonly verdict: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
}

const readEvents = (sql: SqliteResource, profileId: string, includeUnassigned: boolean) => Effect.gen(function* () {
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(feedback)`;
  const scoped = columns.some((column) => column.name === "profile_id");

  if (columns.length === 0 || (!scoped && !includeUnassigned)) return [];

  const where = !scoped ? sql`1` : includeUnassigned
    ? sql`profile_id = ${profileId} OR profile_id IS NULL`
    : sql`profile_id = ${profileId}`;

  const rows = yield* sql<LegacyRow>`SELECT id, ad_id, source, verdict, reason, created_at FROM feedback
    WHERE ${where} ORDER BY julianday(created_at), id LIMIT ${MAX_FEEDBACK_EVENTS + 1}`;

  if (rows.length > MAX_FEEDBACK_EVENTS) return yield* unavailable();

  const events = rows.map((row) => ({
    event_id: isRowId(row.id) ? `legacy_verdict:${row.id}` : null,
    listing_id: row.ad_id, source: row.source, source_version: null,
    kind: "legacy_verdict", value: row.verdict, reason: row.reason,
    created_at: row.created_at, origin: "legacy_review", result_id: null,
  }));

  const decoded = yield* Either.mapLeft(decodeFeedbackEvents({
    schema: "pulse.feedback_events", schema_version: 1n, profile_id: profileId, events,
  }), unavailable);

  return decoded.events;
});

/** Read only the explicitly selected legacy verdict history. No migration or fallback path. */
export const readLegacyFeedbackEvents = (path: string, profileId: string, includeUnassigned = false) =>
  isProfileId(profileId) && strip(profileId) === profileId
    ? readSelectedFeedbackFile(path, (sql) => readEvents(sql, profileId, includeUnassigned)).pipe(Effect.mapError(unavailable))
    : Effect.fail(unavailable());
