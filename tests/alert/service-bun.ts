import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Redacted, Schema } from "effect";
import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileBundle } from "../../src/lib/contracts/profile.ts";
import { AlertArtifacts, AlertArtifactsLive } from "../../src/lib/server/alert/artifacts.ts";
import { AlertEnvironment, loadDestinationConfig } from "../../src/lib/server/alert/config.ts";
import { DiscordHttp, DiscordTransport, DiscordTransportLive } from "../../src/lib/server/alert/discord.ts";
import { AlertError } from "../../src/lib/server/alert/errors.ts";
import { DeliveryOutbox, DeliveryOutboxLive } from "../../src/lib/server/alert/outbox.ts";
import { AlertDispatch, AlertDispatchLive, AlertProfileLock, confirmationText } from "../../src/lib/server/alert/service.ts";

const root = await mkdtemp(join(tmpdir(), "pulse-alert-service-"));
const profileDirectory = join(root, "local_only/profiles/invented");
const ledgerPath = join(root, "separate-ledger/delivery.sqlite3");
const storageRoot = join(profileDirectory, "outbox");
const profileInput = Schema.decodeUnknownSync(Schema.parseJson(ProfileBundle))(await readFile("tests/oracle/basic-run/profile/bundle.json", "utf8"));
const profile = { ...profileInput, paths: { ...profileInput.paths, directory: profileDirectory, ledger_db: ledgerPath, outbox_dir: storageRoot } };
const config = { profile_id: "invented", channel: "redacted_discord", source: "local_only", destination: Redacted.make("https://discord.example.invalid/api/webhooks/1/invented-token") } as const;
const item = { id: "synthetic-job", version: "source-v1" };
const stageInput = { profile_id: "invented", digest_key: "weekly-one", title: "Mulighet i Ålesund", plain_text: "En relevant mulighet.\nSe lokal oversikt.", html: "<p>En relevant mulighet i Ålesund.</p>", items: [item] };
let attempts = 0;
let locks = 0;
const replies = [400, 200, 200];

const program = Effect.gen(function* () {
  const files = yield* AlertArtifacts;
  const outbox = yield* DeliveryOutbox.pipe(Effect.provide(DeliveryOutboxLive({ storageRoot, databasePath: ledgerPath }, "invented")));

  const http = DiscordHttp.of({ post: () => Effect.gen(function* () {
    assert.equal((yield* outbox.list()).find((record) => record.digest_key === "weekly-one")?.status, "uncertain");
    attempts++;
    const status = replies.shift();

    assert(status);

    return { status, body: new TextEncoder().encode('{"id":"123456789"}'), retryAfter: null };
  }).pipe(Effect.orDie) });

  const transport = yield* DiscordTransport.pipe(Effect.provide(DiscordTransportLive), Effect.provideService(DiscordHttp, http));
  const dispatch = yield* AlertDispatch.pipe(Effect.provide(AlertDispatchLive(profile, outbox)), Effect.provideService(DiscordTransport, transport));

  const code = <A, R>(operation: Effect.Effect<A, AlertError, R>) => operation.pipe(Effect.either, Effect.map((result) => {
    assert(Either.isLeft(result));

    return result.left.code;
  }));

  assert.deepEqual(yield* outbox.list(), []);
  assert.deepEqual(yield* outbox.notifiedVersions(), []);
  assert.equal(yield* files.exists(storageRoot), false);
  assert.equal(yield* files.exists(ledgerPath), false);
  assert.equal(yield* code(outbox.stage({ ...stageInput, title: "Subject\r\nBcc: private@example.invalid" })), "payload_invalid");
  assert.equal(yield* files.exists(storageRoot), false);
  assert.equal(yield* code(outbox.stage({ ...stageInput, items: [item, { ...item, version: "source-v2" }] })), "payload_invalid");
  assert.equal(yield* files.exists(storageRoot), false);
  const staged = yield* outbox.stage(stageInput);
  const stagedBytes = yield* files.read(staged.eml_path, 65536);
  const mime = new TextDecoder().decode(stagedBytes);

  assert(!/^To:|^From:|^Cc:|^Bcc:/mi.test(mime));
  assert.deepEqual(yield* outbox.stage(stageInput), staged);
  assert.deepEqual(yield* files.read(staged.eml_path, 65536), stagedBytes);
  assert.equal(yield* files.exists(join(storageRoot, "invented/delivery.sqlite3")), false);
  assert.deepEqual(yield* outbox.notifiedVersions(), []);
  const summary = yield* dispatch.preflight(stageInput.digest_key, config);

  assert.equal(attempts, 0);
  assert.equal(locks, 0);
  assert(!JSON.stringify(summary).includes("invented-token"));
  assert.match(confirmationText(summary), /^SEND [0-9a-f]{64}$/);
  assert.equal(yield* code(dispatch.dispatchApproved(stageInput.digest_key, config, () => Effect.succeed(false))), "approval_declined");
  assert.equal(locks, 0);
  const changed = { ...config, destination: Redacted.make("https://discord.example.invalid/api/webhooks/2/changed-token") };

  assert.equal(yield* code(dispatch.dispatchApproved(stageInput.digest_key, config, () => Effect.succeed(true), Effect.succeed(changed))), "preflight_changed");
  assert.equal(attempts, 0);
  assert.equal((yield* outbox.readDigest(stageInput.digest_key)).staged.status, "staged");

  assert.equal((yield* dispatch.dispatchApproved(stageInput.digest_key, config, () => Effect.succeed(true))).status, "failed");
  assert.deepEqual(yield* outbox.notifiedVersions(), []);
  assert.equal((yield* dispatch.dispatchApproved(stageInput.digest_key, config, () => Effect.succeed(true))).status, "delivered");
  assert.deepEqual(yield* outbox.notifiedVersions(), [item]);
  assert.equal(yield* code(dispatch.dispatchApproved(stageInput.digest_key, config, () => Effect.succeed(true))), "digest_not_dispatchable");
  assert.equal(attempts, 2);

  const pending = yield* outbox.stage({ ...stageInput, digest_key: "weekly-two", title: "A local opportunity", html: null });
  yield* Effect.promise(() => writeFile(pending.push_preview_path, '{"title":"private job"}', { mode: 0o600 }));
  assert.equal(yield* code(dispatch.preflight(pending.digest_key, config)), "artifact_invalid");
  assert.equal((yield* outbox.readDigest(pending.digest_key)).staged.status, "staged");
  yield* Effect.promise(() => chmod(pending.push_preview_path, 0o644));
  assert.equal(yield* code(files.read(pending.push_preview_path, 1024)), "artifact_invalid");

  const configPath = join(profileDirectory, "delivery.toml");

  yield* Effect.promise(() => writeFile(configPath, '[delivery]\nchannel = "redacted_discord"\ndestination = "https://discord.example.invalid/api/webhooks/1/invented-token"\n', { mode: 0o600 }));
  const loaded = yield* loadDestinationConfig(profile).pipe(Effect.provideService(AlertEnvironment, { destination: undefined, channel: undefined, secret: undefined }));

  assert.equal(Redacted.value(loaded.destination), Redacted.value(config.destination));
  assert.equal(yield* code(loadDestinationConfig(profile).pipe(Effect.provideService(AlertEnvironment, { destination: "https://other.example.invalid/token", channel: "redacted_discord", secret: undefined }))), "config_sources_conflict");
  assert.equal((yield* Effect.promise(() => lstat(ledgerPath))).mode & 0o777, 0o600);
  assert.equal((yield* Effect.promise(() => lstat(outbox.artifactsDirectory))).mode & 0o777, 0o700);
});

try {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await chmod(profileDirectory, 0o700);
  await Effect.runPromise(program.pipe(
    Effect.provide(AlertArtifactsLive), Effect.provide(BunContext.layer),
    Effect.provideService(AlertProfileLock, { acquire: () => Effect.sync(() => { locks++; }) }),
  ));
  console.log("alert service: passed");
} finally { await rm(root, { recursive: true, force: true }); }
