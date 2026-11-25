import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, Either } from "effect";
import { strict as assert } from "node:assert";
import { access, chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertError } from "../../src/lib/server/alert/errors.ts";
import { DeliveryLedger, DeliveryLedgerLive } from "../../src/lib/server/alert/ledger.ts";

const directory = await mkdtemp(join(tmpdir(), "alert-ledger-"));
const path = join(directory, "ledger.sqlite3");
const item = { id: "synthetic-job", version: "source-v1" };
const input = { digest_key: "digest-one", payload_hash: "a".repeat(64), has_html: false, items: [item] };
const Caller = Context.GenericTag<string>("ledger-test-caller");
const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: () => new AlertError({ code: "test_io_failed" }) });

const prepareWrite = io(async () => {
  await chmod(directory, 0o700);

  try { const file = await open(path, "wx", 0o600); await file.close(); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
});

const verifyRead = io(async () => {
  const info = await stat(path);
  assert(info.isFile());

  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
});

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

const code = <A>(program: Effect.Effect<A, AlertError>) => run(Effect.either(program)).then((result) => {
  assert(Either.isLeft(result));

  return result.left.code;
});

try {
  const ledger = await run(DeliveryLedger.pipe(Effect.provide(DeliveryLedgerLive({ databasePath: path, profileId: "synthetic", prepareWrite, verifyRead })), Effect.provide(BunFileSystem.layer)));
  assert.deepEqual(await run(ledger.list()), []);
  assert.deepEqual(await run(ledger.notifiedVersions()), []);
  assert.equal(await code(ledger.readDigest("missing")), "digest_not_found");
  await assert.rejects(access(path));
  let installs = 0;
  const install = Effect.gen(function* () { assert.equal(yield* Caller, "retained"); installs++; });
  const first = await run(ledger.stage(input, install).pipe(Effect.provideService(Caller, "retained")));
  assert.equal(first.status, "staged");
  assert.match(first.created_at, /\.\d{6}\+00:00$/);
  assert.deepEqual(await run(ledger.stage(input, install).pipe(Effect.provideService(Caller, "retained"))), first);
  assert.equal(installs, 2);
  assert.equal(await code(ledger.stage({ ...input, payload_hash: "b".repeat(64) }, Effect.sync(() => { installs++; }))), "digest_conflict");
  assert.equal(installs, 2);
  assert.equal(await code(ledger.stage({ ...input, digest_key: "interrupted" }, Effect.fail(new AlertError({ code: "install_failed" })))), "install_failed");
  assert.equal((await run(ledger.list())).length, 1);
  assert.deepEqual(await run(ledger.notifiedVersions()), []);
  // Approval snapshots can become stale before the atomic claim.
  assert.equal(await code(ledger.claim(input.digest_key, { status: "failed", payload_hash: input.payload_hash, items: [item] })), "digest_changed");
  assert.equal(await code(ledger.claim(input.digest_key, { status: "staged", payload_hash: "b".repeat(64), items: [item] })), "digest_changed");
  assert.equal(await code(ledger.claim(input.digest_key, { status: "staged", payload_hash: input.payload_hash, items: [{ ...item, version: "source-v0" }] })), "digest_changed");
  assert.equal((await run(ledger.readDigest(input.digest_key))).row.status, "staged");
  assert.equal((await run(ledger.claim(input.digest_key, { status: "staged", payload_hash: input.payload_hash, items: [item] }))).status, "uncertain");
  assert.equal(await code(ledger.claim(input.digest_key)), "digest_not_dispatchable");
  assert.equal(await code(ledger.mark(input.digest_key, "delivered")), "confirmation_required");
  assert.deepEqual(await run(ledger.notifiedVersions()), []);
  await run(ledger.mark(input.digest_key, "failed"));
  await run(ledger.claim(input.digest_key));
  const delivered = await run(ledger.mark(input.digest_key, "delivered", true));
  assert.deepEqual(await run(ledger.mark(input.digest_key, "delivered", true)), delivered);
  assert.equal(await code(ledger.mark(input.digest_key, "failed")), "delivered_cannot_downgrade");
  assert.deepEqual(await run(ledger.notifiedVersions()), [item]);
  const before = await readFile(path);
  const modified = (await stat(path)).mtimeMs;
  assert.deepEqual((await run(ledger.readDigest(input.digest_key))).items, [item]);
  await run(ledger.list());
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mtimeMs, modified);
  const foreign = await run(DeliveryLedger.pipe(Effect.provide(DeliveryLedgerLive({ databasePath: path, profileId: "foreign", prepareWrite, verifyRead })), Effect.provide(BunFileSystem.layer)));
  assert.equal(await code(foreign.readDigest(input.digest_key)), "profile_mismatch");
  assert.equal(await code(foreign.stage(input, Effect.void)), "profile_mismatch");
  await writeFile(`${path}-journal`, "synthetic recovery marker");
  assert.equal(await code(ledger.readDigest(input.digest_key)), "ledger_invalid");
  await rm(`${path}-journal`);
  await writeFile(path, "not a database");
  assert.equal(await code(ledger.readDigest(input.digest_key)), "ledger_invalid");
  console.log("ledger: passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
