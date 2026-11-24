import { Effect, Either, Schema } from "effect";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PhoneListingId, PhoneListingIds, PhoneReaction } from "../feedback/phone-store-schema.ts";
import { PhoneFeedbackStore, phoneFeedbackStoreLayer, type PhoneFeedbackState } from "../feedback/phone-store.ts";
import { csrfWriteAuthorized, type DashboardScheme } from "./auth.ts";
import type { DashboardSettings } from "./config.ts";
import { DashboardError } from "./errors.ts";
import { jsonResponse, readViewerJson, textResponse, viewerResponse } from "./response.ts";
import type { DashboardSnapshot } from "./snapshot.ts";

export const isFeedbackPath = (path: string) => path === "/app/shortlist-feedback" || path === "/shortlist-feedback";

const bodyLimit = 1024;
const isIds = Schema.is(PhoneListingIds);
const unavailable = () => new DashboardError({ message: "Feedback unavailable" });

const decodeUpdate = Schema.decodeUnknownEither(Schema.Union(
  Schema.Struct({ listing_id: PhoneListingId, field: Schema.Literal("starred"), value: Schema.Boolean }),
  Schema.Struct({ listing_id: PhoneListingId, field: Schema.Literal("reaction"), value: PhoneReaction }),
), { exact: true, onExcessProperty: "error" });

// A configuration mistake must not let feedback writes change the snapshot.
const distinctFiles = (config: DashboardSettings) => Effect.tryPromise({
  try: async () => {
    const { feedbackDb, snapshotDb, snapshotFile } = config;
    const location = (path: string) => realpath(path).catch(() => resolve(path));
    const target = await location(feedbackDb);

    for (const path of snapshotFile === null ? [snapshotDb] : [snapshotDb, snapshotFile]) {
      if (target === await location(path)) throw unavailable();
    }
  },
  catch: unavailable,
});

const readUpdate = (request: Request) => readViewerJson(request, bodyLimit).pipe(
  Effect.flatMap((raw) => Either.mapLeft(decodeUpdate(raw), () => textResponse("Bad request", 400))),
);

const state = (saved: PhoneFeedbackState) => ({ starred: saved.starred, reaction: saved.reaction });

export const shortlistFeedback = (config: DashboardSettings, snapshot: DashboardSnapshot["Type"]) => {
  const store = phoneFeedbackStoreLayer(config.feedbackDb);

  return (request: Request, url: URL, csrf: string, scheme: DashboardScheme) => Effect.gen(function* () {
    const head = request.method === "HEAD";
    const write = request.method === "POST";
    const profile = config.feedbackProfile;

    if (!write && !head && request.method !== "GET") return viewerResponse("", 405);

    if (url.href !== url.origin + url.pathname) return write ? textResponse("Bad request", 400) : viewerResponse("", 404, undefined, undefined, head);

    if (profile === null) return viewerResponse("", 404, undefined, undefined, head);

    if (write && !csrfWriteAuthorized(request, csrf, scheme)) return textResponse("Forbidden", 403);
    const update = write ? yield* readUpdate(request) : undefined;
    const context = yield* snapshot.readFeedbackContext;

    if (context === null || context.profile_id !== profile) return viewerResponse("", 404, undefined, undefined, head);
    const ids = context.listing_ids;

    if (!isIds(ids)) return viewerResponse("", 404, undefined, undefined, head);

    if (update !== undefined && !ids.includes(update.listing_id)) return textResponse("Not found", 404);
    yield* distinctFiles(config);
    const phone = yield* PhoneFeedbackStore;

    if (update !== undefined) {
      const { listing_id: id, ...change } = update;
      const result = yield* phone.update(profile, id, change);

      return jsonResponse(JSON.stringify({ state: state(result) }));
    }

    const saved = yield* phone.read(profile, ids);
    const pairs = [];

    for (const id of ids) {
      const result = saved.get(id);

      if (result === undefined) return yield* unavailable();
      pairs.push([id, state(result)] as const);
    }

    return jsonResponse(JSON.stringify({ csrf_token: csrf, listing_ids: ids, states: Object.fromEntries(pairs) }), head);
  }).pipe(
    Effect.provide(store),
    Effect.catchAll((error) => Effect.succeed(error instanceof Response ? error : textResponse("Feedback unavailable", 503, request.method === "HEAD"))),
  );
};
