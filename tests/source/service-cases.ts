import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Deferred, Effect, Either, Fiber, Layer, Match } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { FilterSourcePolicy } from "../../src/lib/contracts/source.ts";
import { ORIGIN } from "../../src/lib/server/source/core.ts";
import { SourceError } from "../../src/lib/server/source/errors.ts";
import { AddressClientLive } from "../../src/lib/server/source/locations.ts";
import { NavClientLive, SourceHttp } from "../../src/lib/server/source/nav-client.ts";
import { readLocationCheckpoint, saveLocationCheckpoint } from "../../src/lib/server/source/resources.ts";
import { Source, SourceLive, SourceWriterLock } from "../../src/lib/server/source/service.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const policy: FilterSourcePolicy = { rankMissing: () => [], locationCandidates: () => [], insideJobs: () => [] };
const encoded = (body: string, status = 200) => ({ status, bytes: new TextEncoder().encode(body), headers: {} });

const inert = Effect.gen(function* () {
  let fileCalls = 0;
  let networkCalls = 0;
  const deny = () => Effect.sync(() => { fileCalls++; throw new Error("Unexpected filesystem call during inert registration"); });
  const files = FileSystem.makeNoop({ exists: deny, stat: deny, readFile: deny, readFileString: deny, open: deny, makeDirectory: deny, readLink: deny });
  const transport = Layer.succeed(SourceHttp, { request: () => Effect.sync(() => { networkCalls++; throw new Error("Unexpected network call during inert registration"); }) });
  const clients = Layer.mergeAll(NavClientLive, AddressClientLive).pipe(Layer.provide(transport));
  const layer = SourceLive.pipe(Layer.provide(clients), Layer.provide(Layer.succeed(FileSystem.FileSystem, files)));
  yield* Effect.gen(function* () {
    const source = yield* Source;
    assert.equal(fileCalls, 0); assert.equal(networkCalls, 0);
    const blocked = yield* Effect.either(source.refreshPersonal("/synthetic/selected.db", "/synthetic/location-resolution.json", policy));
    assert(Either.isLeft(blocked)); assert.equal(blocked.left.code, "source_writer_lock_unavailable");
    assert.equal(fileCalls, 0); assert.equal(networkCalls, 0);
  }).pipe(Effect.provide(layer));
});

const resources = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-source-resources-" });
  const path = join(directory, "location-resolution.json");
  assert.equal(yield* readLocationCheckpoint(path), null);
  yield* saveLocationCheckpoint(path, id);
  assert.equal(yield* fs.readFileString(path), JSON.stringify({ after: id }));
  assert.equal(Number((yield* fs.stat(path)).mode) & 0o777, 0o600);
  assert.equal(yield* readLocationCheckpoint(path), id);

  for (const value of ['{"after":"bad"}', `{"after":"${id}","extra":true}`, "x".repeat(4097)]) {
    yield* fs.writeFileString(path, value);
    const rejected = yield* Effect.either(readLocationCheckpoint(path));
    assert(Either.isLeft(rejected)); assert.equal(rejected.left.code, "location_checkpoint_invalid");
  }

  yield* fs.writeFile(path, new Uint8Array([255]));
  assert(Either.isLeft(yield* Effect.either(readLocationCheckpoint(path))));
  yield* saveLocationCheckpoint(path, id);
  const failedFiles = { ...fs, rename: () => fs.rename(join(directory, "absent"), join(directory, "absent-target")) };
  const failedWrite = yield* Effect.either(saveLocationCheckpoint(path, id).pipe(Effect.provideService(FileSystem.FileSystem, failedFiles)));
  assert(Either.isLeft(failedWrite)); assert.equal(failedWrite.left.code, "location_checkpoint_write_failed");
  assert.equal(yield* fs.readFileString(path), JSON.stringify({ after: id }));
  assert(!(yield* fs.readDirectory(directory)).some((name) => name.endsWith(".tmp")));

  const entered = yield* Deferred.make<void>();
  const pausedFiles = { ...fs, rename: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)) };
  const fiber = yield* Effect.fork(saveLocationCheckpoint(path, id).pipe(Effect.provideService(FileSystem.FileSystem, pausedFiles)));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  assert(!(yield* fs.readDirectory(directory)).some((name) => name.endsWith(".tmp")));
  assert.equal(yield* fs.readFileString(path), JSON.stringify({ after: id }));
}));

const workflow = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-source-workflow-" });
  const path = join(directory, "source.db");
  const checkpoint = join(directory, "location-resolution.json");
  const entered = yield* Deferred.make<void>();
  let paused = false;
  let requests = 0;

  const transport = Layer.succeed(SourceHttp, { request: (url) => Effect.gen(function* () {
    requests++;

    if (url === ORIGIN + "/api/publicToken") return encoded("eyJsynthetic.payload.signature");

    if (paused) { yield* Deferred.succeed(entered, undefined); yield* Effect.never; }

    if (url === ORIGIN + "/api/v1/feed?last") return encoded(JSON.stringify({ id, items: [] }));

    if (url === ORIGIN + "/api/v1/feed/" + id) return encoded("", 304);

    return yield* Effect.die("Unexpected synthetic HTTP destination");
  }) });

  const clients = Layer.mergeAll(NavClientLive, AddressClientLive).pipe(Layer.provide(transport));
  const services = SourceLive.pipe(Layer.provide(clients));
  const held = new Set<string>();
  let acquired = 0;
  let released = 0;

  const lock: SourceWriterLock["Type"] = { acquire: (databasePath) => Effect.acquireRelease(Effect.gen(function* () {
    if (held.has(databasePath)) return yield* new SourceError({ message: "source_database_busy", code: "source_database_busy" });
    held.add(databasePath); acquired++;
  }), () => Effect.sync(() => { held.delete(databasePath); released++; })).pipe(Effect.asVoid) };

  yield* Effect.gen(function* () {
    const source = yield* Source;
    // Normal explicit sync does not look up the workflow lock.
    assert.deepEqual(yield* source.collect(path), { pages: 1, events: 0, caught_up: true });
    assert.equal(acquired, 0); assert.equal(released, 0);
    const current = new Date().toISOString();
    const fresh = yield* source.checkFresh(path, current, 10000);
    assert.equal(fresh[0], true);
    assert.equal((yield* source.checkFresh(path, "2000-01-01T00:00:00Z", 10000))[0], false);
    assert.deepEqual(yield* source.checkFresh(join(directory, "absent.db"), current, 10000), [false, null]);
    assert.equal(yield* fs.exists(join(directory, "absent.db")), false);
    const count = requests;
    const missingLock = yield* Effect.either(source.refreshPersonal(path, checkpoint, policy));
    assert(Either.isLeft(missingLock)); assert.equal(missingLock.left.code, "source_writer_lock_unavailable");
    assert.equal(requests, count);
    const run = source.refreshPersonal(path, checkpoint, policy).pipe(Effect.provideService(SourceWriterLock, lock));
    const summary = yield* run;
    assert.equal(summary.ready, true); assert.equal(summary.feed_requests, 2); assert.equal(summary.location_requests, 0); assert.equal(summary.occupation_pending, 0);
    assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(held.size, 0);
    assert.equal(yield* fs.exists(checkpoint), false);
    assert.equal(yield* fs.exists(join(directory, "local-pipeline-run.json")), false);
    paused = true;
    const first = yield* Effect.fork(run);
    yield* Deferred.await(entered);
    assert(held.has(path));
    const busy = yield* Effect.either(run);
    assert(Either.isLeft(busy)); assert.equal(busy.left.code, "source_database_busy");
    yield* Fiber.interrupt(first);
    assert.equal(held.size, 0); assert.equal(acquired, released);
    paused = false;
    yield* run;
    assert.equal(held.size, 0); assert.equal(acquired, released);
    yield* fs.writeFileString(checkpoint, "broken checkpoint");
    const failed = yield* Effect.either(run);
    assert(Either.isLeft(failed)); assert.equal(failed.left.code, "location_checkpoint_invalid");
    assert.equal(held.size, 0); assert.equal(acquired, released);
  }).pipe(Effect.provide(services));
}));

const group = process.argv[2];

const program = Match.value(group).pipe(
  Match.when("inert", () => inert), Match.when("resources", () => resources),
  Match.when("workflow", () => workflow), Match.orElse(() => Effect.die("Unknown test group")),
);

await Effect.runPromise(program.pipe(Effect.provide(BunContext.layer)));

console.log(`${group}: passed`);
