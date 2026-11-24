import { Data, Effect, Either, Option } from "effect";
import { decodeFeedbackEvents, MAX_FEEDBACK_EVENTS, type FeedbackEvent } from "../../contracts/feedback-events.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { openJudgeDatabase } from "../judge/database.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { readCachedHostedFeedback } from "./hosted-feedback.ts";
import { readLegacyFeedbackEvents } from "./legacy-events.ts";
import { readPersonalRatingEvents } from "./personal-rating.ts";
import { readPhoneFeedbackEvents } from "./phone-events.ts";

export const LOCAL_FEEDBACK_JSON_MAX = 8_000_000;

export class LocalFeedbackExportError extends Data.TaggedError("LocalFeedbackExportError")<{}> {}

interface LocalFeedbackInputs {
  readonly profileId: string;
  readonly directory: string;
  readonly review: string | null;
  readonly phone: string | null;
  readonly legacy: string | null;
  readonly includeUnassigned: boolean;
}

// Only admitted existing filenames reach this owner. The Judge connection is
// read-only; neither missing nor uninitialized rating history creates state.
const readRating = (inputs: LocalFeedbackInputs, path: string) => Effect.scoped(Effect.gen(function* () {
  const state = yield* openJudgeDatabase({
    profile_id: inputs.profileId, directory: inputs.directory, path, readonly: true, require_existing: false,
  });

  const rows = yield* readPersonalRatingEvents(state, inputs.profileId);

  return rows.map((row): FeedbackEvent => ({
    event_id: `rating:${row.id}`, listing_id: row.ad_id, source: row.source, source_version: row.source_version,
    kind: "rating", value: row.rating, reason: row.reason, created_at: row.created_at, origin: "local_ratings", result_id: row.result_id,
  }));
}));

export const collectLocalFeedback = (inputs: LocalFeedbackInputs) => Effect.gen(function* () {
  const rating = inputs.review === null ? [] : yield* readRating(inputs, inputs.review);
  const cached = yield* readCachedHostedFeedback({ profileId: inputs.profileId, cacheDirectory: inputs.directory });
  const phone = inputs.phone === null ? [] : yield* readPhoneFeedbackEvents(inputs.phone, inputs.profileId);
  const legacy = inputs.legacy === null ? [] : yield* readLegacyFeedbackEvents(inputs.legacy, inputs.profileId, inputs.includeUnassigned);
  const events = new Map<string, FeedbackEvent>();

  for (const source of [rating, cached, phone, legacy]) {
    for (const event of source) {
      events.set(event.event_id, event);

      if (events.size > MAX_FEEDBACK_EVENTS) return yield* new LocalFeedbackExportError();
    }
  }

  const sortable: { event: FeedbackEvent; instant: bigint }[] = [];

  for (const event of events.values()) {
    const time = parseIsoTime(event.created_at);

    if (Option.isNone(time) || !time.value.aware) return yield* new LocalFeedbackExportError();
    sortable.push({ event, instant: time.value.epochMicros });
  }

  sortable.sort((left, right) => left.instant < right.instant ? -1 : left.instant > right.instant ? 1 : codepointOrder(left.event.event_id, right.event.event_id));

  return yield* Either.mapLeft(decodeFeedbackEvents({
    schema: "pulse.feedback_events", schema_version: 1n, profile_id: inputs.profileId, events: sortable.map(({ event }) => event),
  }), () => new LocalFeedbackExportError());
});

const wire = (event: FeedbackEvent) => ({
  event_id: event.event_id, listing_id: event.listing_id, source: event.source, source_version: event.source_version,
  kind: event.kind, value: event.value, reason: event.reason, created_at: event.created_at, origin: event.origin, result_id: event.result_id,
});

export const renderLocalFeedback = (profileId: string, events: readonly FeedbackEvent[], pretty: boolean) => Effect.suspend(() => {
  const empty = JSON.stringify({ schema: "pulse.feedback_events", schema_version: 1, profile_id: profileId, events: [] }, null, pretty ? 2 : undefined) + "\n";
  const at = empty.lastIndexOf("[]") + 1;
  const prefix = empty.slice(0, at) + (pretty && events.length ? "\n" : "");
  const suffix = (pretty && events.length ? "\n  " : "") + empty.slice(at);
  const separator = pretty ? ",\n" : ",";
  let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const parts: string[] = [];
  const counts = { star: 0, reaction: 0, rating: 0, legacy_verdict: 0 };

  for (const event of events) {
    const text = JSON.stringify(wire(event), null, pretty ? 2 : undefined);
    const part = pretty ? text.split("\n").map((line) => "    " + line).join("\n") : text;
    bytes += Buffer.byteLength(part) + (parts.length ? separator.length : 0);

    if (bytes > LOCAL_FEEDBACK_JSON_MAX) return Effect.fail(new LocalFeedbackExportError());
    parts.push(part);
    counts[event.kind]++;
  }

  const content = prefix + parts.join(separator) + suffix;
  const summary = `Feedback: star=${counts.star}, reaction=${counts.reaction}, rating=${counts.rating}, legacy_verdict=${counts.legacy_verdict}\n`;

  return Effect.succeed({ content, summary });
});
