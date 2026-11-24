import { Data, Effect, Either, Schema } from "effect";
import { decodeFeedbackEvents, decodeFeedbackEventsBytes, MAX_FEEDBACK_EVENTS, MAX_HOSTED_FEEDBACK_BYTES, type FeedbackEvent } from "../../contracts/feedback-events.ts";
import { readReadonlySqlite } from "../shared/readonly-sqlite.ts";
import type { SqliteResource } from "../shared/sqlite-resource.ts";
import { decodePhoneStoreRow, decodePinnedPhoneStoreRow, inspectPhoneStoreSchema, isPhoneStoreSchemaObject, PhoneProfileId, PINNED_PHONE_SCHEMA_QUERY, type PhoneStoreRow } from "./phone-store-schema.ts";
import { readSelectedFeedbackFile } from "./read-selected.ts";

const batchSize = 500;
const isProfileId = Schema.is(PhoneProfileId);

export class PhoneFeedbackEventsError extends Data.TaggedError("PhoneFeedbackEventsError")<{ readonly message: string }> {}

const unavailable = () => new PhoneFeedbackEventsError({ message: "Phone feedback cannot be read" });

function* projectPhoneEvents(row: PhoneStoreRow): Iterable<FeedbackEvent> {
  const identity = { listing_id: row.listing_id, source: "nav", source_version: null };
  const context = { reason: "", created_at: row.updated_at, origin: "phone_shortlist" as const, result_id: null };
  const suffix = `${row.listing_id}:${row.updated_at}`;

  if (row.starred === 1n) yield { event_id: `star:${suffix}`, ...identity, kind: "star", value: true, ...context };

  if (row.reaction !== null) yield { event_id: `reaction:${suffix}`, ...identity, kind: "reaction", value: row.reaction, ...context };
}

const readEvents = (sql: SqliteResource, profileId: string) => Effect.gen(function* () {
  if ((yield* inspectPhoneStoreSchema(sql)) !== "ready") return yield* unavailable();
  const events: FeedbackEvent[] = [];
  let lastId: string | undefined;

  for (;;) {
    const after = lastId === undefined ? sql`` : sql`AND listing_id > ${lastId}`;

    const rows = yield* sql`SELECT listing_id, starred, reaction, updated_at FROM shortlist_feedback
      WHERE profile_id = ${profileId} ${after} ORDER BY listing_id LIMIT ${batchSize}`;

    for (const row of rows) {
      const saved = yield* decodePhoneStoreRow(row);
      lastId = saved.listing_id;

      for (const event of projectPhoneEvents(saved)) events.push(event);

      if (events.length > MAX_FEEDBACK_EVENTS) return yield* unavailable();
    }

    if (rows.length < batchSize) break;
  }

  const decoded = yield* Either.mapLeft(decodeFeedbackEvents({
    schema: "pulse.feedback_events", schema_version: 1n, profile_id: profileId, events,
  }), unavailable);

  return decoded.events;
});

/** Read current controls from an explicitly selected local phone store, not action history. */
export const readPhoneFeedbackEvents = (path: string, profileId: string) => isProfileId(profileId)
  ? readSelectedFeedbackFile(path, (sql) => readEvents(sql, profileId)).pipe(Effect.mapError(unavailable))
  : Effect.fail(unavailable());

const compareAscii = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Export complete current controls from the selected private hosted phone store. */
export const readHostedFeedbackEventsResponse = (path: string, profileId: string) => Effect.gen(function* () {
  if (!isProfileId(profileId)) return yield* unavailable();

  const bytes = yield* readReadonlySqlite(path, "feedback", (db) => {
    const schema = db.query(PINNED_PHONE_SCHEMA_QUERY).values();

    if (schema.length !== 1 || !isPhoneStoreSchemaObject(schema[0])) throw unavailable();

    const rows = db.query(`SELECT listing_id, starred, reaction, updated_at FROM main.shortlist_feedback
      WHERE profile_id = ? ORDER BY listing_id LIMIT ?`).iterate(profileId, MAX_FEEDBACK_EVENTS + 1);

    const events: FeedbackEvent[] = [];
    const document = { schema: "pulse.feedback_events", schema_version: 1, profile_id: profileId, events };
    // The empty document accounts for the envelope; each retained event adds its compact bytes and separator.
    let size = Buffer.byteLength(JSON.stringify(document));
    let sourceRows = 0;
    let previous = "";

    for (const raw of rows) {
      sourceRows += 1;

      if (sourceRows > MAX_FEEDBACK_EVENTS) throw unavailable();
      const row = decodePinnedPhoneStoreRow(raw);

      if (row.listing_id <= previous) throw unavailable();
      previous = row.listing_id;

      for (const event of projectPhoneEvents(row)) {
        if (events.length === MAX_FEEDBACK_EVENTS) throw unavailable();
        size += Buffer.byteLength(JSON.stringify(event)) + (events.length === 0 ? 0 : 1);

        if (size > MAX_HOSTED_FEEDBACK_BYTES) throw unavailable();
        events.push(event);
      }
    }

    events.sort((left, right) => compareAscii(left.created_at, right.created_at) || compareAscii(left.event_id, right.event_id));
    const encoded = new TextEncoder().encode(JSON.stringify(document));

    if (Either.isLeft(decodeFeedbackEventsBytes(encoded, MAX_HOSTED_FEEDBACK_BYTES))) throw unavailable();

    return encoded;
  }).pipe(Effect.mapError(unavailable));

  if (bytes === null) return yield* unavailable();

  return bytes;
});
