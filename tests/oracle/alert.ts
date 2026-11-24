import { FileSystem } from "@effect/platform";
import { Effect, Redacted, Schema } from "effect";
import { join } from "node:path";
import { ProfileBundle } from "../../src/lib/contracts/profile.ts";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { AlertArtifacts, AlertArtifactsLive } from "../../src/lib/server/alert/artifacts.ts";
import { DiscordHttp, DiscordTransport, DiscordTransportLive, endpoint } from "../../src/lib/server/alert/discord.ts";
import { AlertError } from "../../src/lib/server/alert/errors.ts";
import { DeliveryOutbox, DeliveryOutboxLive, type DeliveryOutboxService } from "../../src/lib/server/alert/outbox.ts";
import { AlertDispatch, AlertDispatchLive, AlertProfileLock } from "../../src/lib/server/alert/service.ts";
import { selectDigest } from "../../src/lib/server/select/core.ts";
import { compareText } from "./compare.ts";
import { produceDigestBoundary, recordedDigest } from "./select.ts";

const bundle = "duplicate-alert";

const Fixture = Schema.parseJson(Schema.Struct({ destination: Schema.String, host: Schema.String, target: Schema.String,
  responses: Schema.Array(Schema.Struct({ status: Schema.Number, body: Schema.String })),
}));

export const compareAlertDigest = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const liveFiles = yield* AlertArtifacts.pipe(Effect.provide(AlertArtifactsLive));
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-alert-oracle-" });
  const databasePath = join(temp, "ledger.sqlite3");
  const profileInput = yield* fs.readFileString(`tests/oracle/${bundle}/profile/bundle.json`).pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(ProfileBundle))));
  const profile = { ...profileInput, paths: { ...profileInput.paths, ledger_db: databasePath } };
  const artifactData = new Map<string, Uint8Array>();

  // Literal recorder paths are external artifact-resource inputs, not path masks.
  // Only SQLite uses a fresh invented temp path; no recorder sandbox is opened.
  const files = AlertArtifacts.of({
    directory: (path, create, privateLeaf) => path.startsWith(temp) ? liveFiles.directory(path, create, privateLeaf) : Effect.void,
    privateFile: (path, create) => liveFiles.privateFile(path, create),
    exists: (path) => path.startsWith(temp) ? liveFiles.exists(path) : Effect.succeed(artifactData.has(path)),
    read: (path, maximum) => Effect.suspend(() => {
      const bytes = artifactData.get(path);

      return bytes && bytes.byteLength <= maximum ? Effect.succeed(bytes.slice()) : Effect.fail(new AlertError({ code: "artifact_invalid" }));
    }),
    install: (path, bytes) => Effect.sync(() => { artifactData.set(path, bytes.slice()); }),
  });

  const selected = yield* produceDigestBoundary(bundle);
  const fixture = yield* fs.readFileString("tests/fixtures/port-oracle/duplicate-alert/inputs/discord.json").pipe(Effect.flatMap(Schema.decodeUnknown(Fixture)));
  const replies = [...fixture.responses];
  let outbox: DeliveryOutboxService;

  const http = DiscordHttp.of({ post: (destination) => Effect.gen(function* () {
    const target = endpoint(Redacted.value(destination));

    if (!target || target.host !== fixture.host || target.target !== fixture.target) return yield* Effect.dieMessage("Unexpected frozen Discord destination");
    const records = yield* outbox.list();

    if (records[0]?.status !== "uncertain") return yield* Effect.dieMessage("POST occurred before durable uncertain claim");
    const reply = replies.shift();

    if (!reply) return yield* Effect.dieMessage("Unexpected extra Discord attempt");

    return { status: reply.status, body: new TextEncoder().encode(reply.body), retryAfter: null };
  }).pipe(Effect.orDie) });

  yield* Effect.gen(function* () {
    outbox = yield* DeliveryOutbox.pipe(Effect.provide(DeliveryOutboxLive({ storageRoot: profile.paths.outbox_dir, databasePath }, profile.profile_id)));
    const transport = yield* DiscordTransport.pipe(Effect.provide(DiscordTransportLive));
    const dispatch = yield* AlertDispatch.pipe(Effect.provide(AlertDispatchLive(profile, outbox)), Effect.provideService(DiscordTransport, transport));
    const config = { profile_id: profile.profile_id, destination: Redacted.make(fixture.destination), channel: "redacted_discord", source: "local_only" } as const;

    const staged = yield* outbox.stage({ profile_id: profile.profile_id, digest_key: "invented-discord", title: "Invented job update",
      plain_text: selected.text, html: selected.html, items: selected.digest.candidates.map(({ id, version }) => ({ id, version })),
    });

    for (const outcome of ["failed", "delivered"]) {
      const result = yield* dispatch.dispatch(staged.digest_key, config);

      if (result.status !== outcome) return yield* Effect.dieMessage("Unexpected frozen Discord outcome");
    }

    const delivered = yield* outbox.notifiedVersions();
    const secondRequest = { ...selected.request, delivered };
    const second = yield* selectDigest(secondRequest, secondRequest.snapshot.checked_at);

    if (second.status !== "quiet" || second.candidates.length) return yield* Effect.dieMessage("Confirmed notification did not suppress repeat digest");

    if (replies.length) return yield* Effect.dieMessage("Unused frozen Discord reply");
    yield* compareText(`tests/oracle/${bundle}/alert/second-run-digest.json`, recordedDigest(second, secondRequest));
  }).pipe(
    Effect.provideService(AlertArtifacts, files), Effect.provideService(DiscordHttp, http),
    Effect.provideService(AlertProfileLock, { acquire: () => Effect.void }), Effect.provide(FixedOsloClock),
  );
}));
