import { Either, Schema } from "effect";
import { parseStrictContractBytes } from "../server/shared/strict-contract-json.ts";
import { awareTimestamp, boundedText, header } from "./support.ts";

export const MAX_FEEDBACK_EVENTS = 50_000;
export const FEEDBACK_EVENTS_PATH = "/api/v1/feedback-events";
export const MAX_HOSTED_FEEDBACK_BYTES = 2 * 1024 * 1024;

const text = boundedText();
const nullableText = Schema.NullOr(boundedText(2000, true));

const eventFields = {
  event_id: text,
  listing_id: text,
  source: text,
  source_version: nullableText,
  reason: nullableText,
  created_at: awareTimestamp,
  origin: Schema.Literal("phone_shortlist", "local_ratings", "legacy_review"),
  result_id: nullableText,
};

const FeedbackEvent = Schema.Union(
  Schema.Struct({ ...eventFields, kind: Schema.Literal("star"), value: Schema.Boolean }),
  Schema.Struct({ ...eventFields, kind: Schema.Literal("reaction"), value: Schema.Literal("up", "down") }),
  Schema.Struct({ ...eventFields, kind: Schema.Literal("rating"), value: Schema.Literal("very_good", "good", "unsure", "bad", "very_bad") }),
  Schema.Struct({ ...eventFields, kind: Schema.Literal("legacy_verdict"), value: Schema.Literal("good", "bad", "unsure") }),
);

const events = Schema.Array(FeedbackEvent).pipe(
  Schema.maxItems(MAX_FEEDBACK_EVENTS),
  Schema.filter((rows) => new Set(rows.map((event) => event.event_id)).size === rows.length, {
    message: () => "Expected unique feedback event IDs",
  }),
);

export const FeedbackEvents = Schema.Struct({ ...header("pulse.feedback_events", 1), profile_id: text, events });

export type FeedbackEvent = typeof FeedbackEvent.Type;

export type FeedbackEvents = typeof FeedbackEvents.Type;

export const decodeFeedbackEvents = Schema.decodeUnknownEither(FeedbackEvents, { onExcessProperty: "error", exact: true });

export const decodeFeedbackEventsBytes = (bytes: Uint8Array, maxBytes: number) =>
  Either.flatMap(parseStrictContractBytes(bytes, maxBytes), decodeFeedbackEvents);
