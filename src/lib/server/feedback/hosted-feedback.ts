import { Data, Effect, Either, Predicate, Schema } from "effect";
import { join } from "node:path";
import { decodeFeedbackEvents, MAX_FEEDBACK_EVENTS, MAX_HOSTED_FEEDBACK_BYTES, type FeedbackEvent, type FeedbackEvents } from "../../contracts/feedback-events.ts";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { hostedFeedbackPath, readHostedFeedbackFile } from "./hosted-feedback-files.ts";
import { PhoneProfileId } from "./phone-store-schema.ts";

const cacheFilename = "hosted-feedback.json";
const maxBytes = MAX_HOSTED_FEEDBACK_BYTES;
const isProfileId = Schema.is(PhoneProfileId);
const knownKinds: Record<FeedbackEvent["kind"], true> = { star: true, reaction: true, rating: true, legacy_verdict: true };

export class HostedFeedbackError extends Data.TaggedError("HostedFeedbackError")<{ readonly message: string }> {}

const cacheFailed = () => new HostedFeedbackError({ message: "Private hosted feedback cache cannot be read safely" });
const invalid = () => new HostedFeedbackError({ message: "Hosted feedback response is invalid" });

type PhoneEvent = Extract<FeedbackEvent, { kind: "star" | "reaction" }> & { readonly origin: "phone_shortlist" };

type HostedFeedback = Omit<FeedbackEvents, "events"> & { readonly events: readonly PhoneEvent[] };

const isPhoneEvent = (event: FeedbackEvent): event is PhoneEvent =>
  (event.kind === "star" || event.kind === "reaction") && event.origin === "phone_shortlist";

export const decodeHostedFeedback = (bytes: Uint8Array, profileId: string): Either.Either<HostedFeedback, HostedFeedbackError> => Either.gen(function* () {
  const raw = yield* Either.mapLeft(parseStrictContractBytes(bytes, maxBytes), invalid);

  if (!isProfileId(profileId) || raw.profile_id !== profileId || !Array.isArray(raw.events) || raw.events.length > MAX_FEEDBACK_EVENTS) {
    return yield* Either.left(invalid());
  }

  const retained: unknown[] = [];

  for (const event of raw.events) {
    if (!Predicate.isRecord(event) || !Predicate.isString(event.kind)) return yield* Either.left(invalid());

    if (Object.hasOwn(knownKinds, event.kind)) retained.push(event);
  }

  const decoded = yield* Either.mapLeft(decodeFeedbackEvents({ ...raw, events: retained }), invalid);
  const events = decoded.events;

  if (!events.every(isPhoneEvent)) return yield* Either.left(invalid());

  return { ...decoded, events };
});

export interface HostedFeedbackSelection {
  readonly profileId: string;
  readonly cacheDirectory: string;
}

const cachePath = ({ cacheDirectory, profileId }: HostedFeedbackSelection) => {
  if (!isProfileId(profileId)) throw invalid();

  return join(hostedFeedbackPath(cacheDirectory), cacheFilename);
};

/** Read only the selected profile's saved copy. An absent copy has no events. */
export const readCachedHostedFeedback = (selection: HostedFeedbackSelection) => Effect.tryPromise({
  try: async () => {
    const saved = await readHostedFeedbackFile(cachePath(selection), maxBytes);

    return saved === null ? [] : Either.getOrThrow(decodeHostedFeedback(saved, selection.profileId)).events;
  },
  catch: cacheFailed,
});

