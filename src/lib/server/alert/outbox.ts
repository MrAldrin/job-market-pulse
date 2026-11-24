import { Context, Effect, Layer, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { StagePayload, type DeliveryStatus, type ReadOnlyDigest, type StagedDigest } from "../../contracts/alert.ts";
import { AlertArtifacts } from "./artifacts.ts";
import { artifactNames, payloadHash, pushPreviewBytes } from "./core.ts";
import { AlertError } from "./errors.ts";
import { DeliveryLedger, DeliveryLedgerLive, type LedgerExpectation, type LedgerRow } from "./ledger.ts";
import { mimeBytes } from "./mime.ts";

export interface OutboxConfig { readonly storageRoot: string; readonly databasePath?: string }

export const makeDeliveryOutbox = (options: OutboxConfig, profileId: string) => Effect.gen(function* () {
  const files = yield* AlertArtifacts;
  const root = resolve(options.storageRoot);
  const profileDirectory = join(root, profileId);
  const artifactsDirectory = join(profileDirectory, "artifacts");
  const databasePath = resolve(options.databasePath ?? join(profileDirectory, "delivery.sqlite3"));
  const verifyRead = files.directory(dirname(databasePath)).pipe(Effect.zipRight(files.privateFile(databasePath)));

  const prepareWrite = Effect.gen(function* () {
    yield* files.directory(root, true); yield* files.directory(profileDirectory, true); yield* files.directory(artifactsDirectory, true);
    yield* files.directory(dirname(databasePath), true); yield* files.privateFile(databasePath, true);
  });

  const ledger = yield* DeliveryLedger.pipe(Effect.provide(DeliveryLedgerLive({ databasePath, profileId, prepareWrite, verifyRead })));

  const staged = (row: LedgerRow): StagedDigest => {
    const names = artifactNames(row.digest_key);

    return { profile_id: profileId, digest_key: row.digest_key, status: row.status, created_at: row.created_at, updated_at: row.updated_at,
      eml_path: join(artifactsDirectory, names.eml), html_path: row.has_html ? join(artifactsDirectory, names.html) : null,
      push_preview_path: join(artifactsDirectory, names.pushPreview) };
  };

  return {
    storageRoot: root, databasePath, artifactsDirectory,
    stage: (input: StagePayload) => Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknown(StagePayload, { onExcessProperty: "error" })(input).pipe(Effect.mapError(() => new AlertError({ code: "payload_invalid" })));

      if (payload.profile_id !== profileId) return yield* new AlertError({ code: "profile_mismatch" });
      const names = artifactNames(payload.digest_key);
      const hash = payloadHash(payload);

      const install = Effect.gen(function* () {
        yield* files.install(join(artifactsDirectory, names.eml), mimeBytes(payload, hash));

        if (payload.html !== null) yield* files.install(join(artifactsDirectory, names.html), new TextEncoder().encode(payload.html));
        yield* files.install(join(artifactsDirectory, names.pushPreview), pushPreviewBytes());
      });

      const row = yield* ledger.stage({ digest_key: payload.digest_key, payload_hash: hash, has_html: payload.html !== null, items: payload.items }, install);

      return staged(row);
    }),
    readDigest: (key: string): Effect.Effect<ReadOnlyDigest, AlertError> => ledger.readDigest(key).pipe(Effect.map(({ row, items }) => ({ staged: staged(row), payload_hash: row.payload_hash, has_html: row.has_html === 1, items }))),
    list: () => ledger.list().pipe(Effect.map((rows) => rows.map(staged))),
    notifiedVersions: ledger.notifiedVersions,
    claim: (key: string, expected?: LedgerExpectation) => ledger.claim(key, expected).pipe(Effect.map(staged)),
    mark: (key: string, outcome: Exclude<DeliveryStatus, "staged">, confirmed = false) => ledger.mark(key, outcome, confirmed).pipe(Effect.map(staged)),
  };
});

export type DeliveryOutboxService = Effect.Effect.Success<ReturnType<typeof makeDeliveryOutbox>>;

export class DeliveryOutbox extends Context.Tag("pulse/DeliveryOutbox")<DeliveryOutbox, DeliveryOutboxService>() {}

export const DeliveryOutboxLive = (options: OutboxConfig, profileId: string) => Layer.effect(DeliveryOutbox, makeDeliveryOutbox(options, profileId));
