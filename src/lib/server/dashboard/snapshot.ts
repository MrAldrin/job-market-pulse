import { Context, Effect, Layer } from "effect";
import { decodeSnapshotDocumentBytes, type SnapshotDocument } from "../../contracts/snapshot.ts";
import { SnapshotError } from "../snapshot/errors.ts";
import { SnapshotJsonFile } from "../snapshot/json-file.ts";
import { snapshotJsonBytes } from "../snapshot/serialization.ts";
import { SnapshotStore, type ShortlistMetadata } from "../snapshot/store.ts";
import { DashboardConfig } from "./config.ts";
import { APP_CSP, viewerResponse } from "./response.ts";

interface DashboardJson {
  readonly bytes: Uint8Array;
  readonly publishedAt: string | null;
}

export class DashboardSnapshot extends Context.Tag("pulse/DashboardSnapshot")<DashboardSnapshot, {
  readonly readDocument: Effect.Effect<SnapshotDocument | null, SnapshotError>;
  readonly readJson: Effect.Effect<DashboardJson | null, SnapshotError>;
  readonly readFeedbackContext: Effect.Effect<ShortlistMetadata | null, SnapshotError>;
}>() {}

const feedbackContext = (document: SnapshotDocument | null): ShortlistMetadata | null => document === null ? null : {
  profile_id: document.profile.id, listing_ids: document.jobs.map(({ id }) => id),
};

const decodeDocument = (bytes: Uint8Array) =>
  Effect.mapError(decodeSnapshotDocumentBytes(bytes), () => new SnapshotError({ message: "Invalid dashboard snapshot JSON" }));

export const DashboardSnapshotLive = Layer.effect(DashboardSnapshot, Effect.gen(function* () {
  const { snapshotDb, snapshotFile, localSettings } = yield* DashboardConfig;
  const store = yield* SnapshotStore;
  const file = yield* SnapshotJsonFile;

  if (snapshotFile === null) {
    const latest = store.latest(snapshotDb);

    const readJson = latest.pipe(Effect.map((record) =>
      record?.dashboardJson == null ? null : { bytes: record.dashboardJson, publishedAt: record.publishedAt }));

    return {
      readJson,
      readDocument: readJson.pipe(Effect.flatMap((json) => json === null ? Effect.succeed(null) : decodeDocument(json.bytes))),
      readFeedbackContext: latest.pipe(Effect.flatMap((record) => record?.dashboardJson == null ? Effect.succeed(record?.shortlist ?? null) :
        decodeDocument(record.dashboardJson).pipe(Effect.map(feedbackContext)))),
    };
  }

  const readDocument = localSettings === undefined ? file.read(snapshotFile) : file.readOptional(snapshotFile).pipe(
    Effect.flatMap((document) => document === null || document.profile.id === localSettings.profileId
      ? Effect.succeed(document) : Effect.fail(new SnapshotError({ message: "Saved snapshot belongs to another profile" }))),
  );

  return {
    readDocument,
    readJson: readDocument.pipe(Effect.map((document) => document === null ? null : { bytes: snapshotJsonBytes(document), publishedAt: null })),
    readFeedbackContext: readDocument.pipe(Effect.map(feedbackContext)),
  };
}));

const viewerSnapshotText = (body: string, status: number, head: boolean) =>
  viewerResponse(body, status, "text/plain; charset=utf-8", undefined, head, APP_CSP);

export const dashboardSnapshotResponse = (head: boolean): Effect.Effect<Response, never, DashboardSnapshot> => Effect.gen(function* () {
  const snapshot = yield* DashboardSnapshot;
  const json = yield* snapshot.readJson;

  if (json === null) return viewerSnapshotText("No dashboard snapshot yet", 404, head);

  return yield* Effect.try({
    try: () => viewerResponse(json.bytes, 200, "application/json; charset=utf-8",
      json.publishedAt === null ? undefined : { "X-Digest-Published": json.publishedAt }, head, APP_CSP),
    catch: () => new SnapshotError({ message: "Invalid dashboard snapshot response" }),
  });
}).pipe(Effect.catchAll(() => Effect.succeed(viewerSnapshotText("Digest store unavailable", 503, head))));
