import { Reactivity } from "@effect/experimental";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Database } from "bun:sqlite";
import { Clock, Context, Effect, Either, Layer, Match, Option, Stream, TestClock, TestContext } from "effect";
import assert from "node:assert/strict";
import { join } from "node:path";
import { acquireSqliteResource } from "../../src/lib/server/shared/sqlite-resource.ts";
import { ORIGIN } from "../../src/lib/server/source/core.ts";
import { AddressClient, AddressClientLive, resolveCandidates } from "../../src/lib/server/source/locations.ts";
import { NavClient, NavClientLive, NavClientReplay, SourceHttp } from "../../src/lib/server/source/nav-client.ts";
import { sync } from "../../src/lib/server/source/ingestion.ts";
import { captureSourceDatabase } from "../oracle/source-database.ts";
import { beginObservationRun, getObservation, recordObservation } from "../../src/lib/server/source/observations.ts";
import { readApplicationDeadline, readHistoricalAd, readStatus, readVersion, sourceState, sourceTables } from "../../src/lib/server/source/readers.ts";
import { fetchCurrentAdTexts } from "../../src/lib/server/source/review-text.ts";
import { ingestionRules, Source, SourceLive, SourceWriterLock } from "../../src/lib/server/source/service.ts";
import { acquireStore, readSnapshot, withReservedConnection } from "../../src/lib/server/source/store.ts";
import { SUPPORTED_PROVIDER } from "../../src/lib/server/shared/workplace-fingerprint.ts";

class Marker extends Context.Tag("tests/source/CallerMarker")<Marker, string>() {}

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const cursor = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const now = "2026-11-17T10:00:00Z";
const version = "2026-11-15T12:00:00+00:00";

const checkCaller = Effect.gen(function* () {
  const marker = yield* Effect.serviceOption(Marker);
  assert(Option.isSome(marker)); assert.equal(marker.value, "caller-preserved");
  assert.equal(yield* Clock.currentTimeMillis, Date.parse(now));
});

const encoded = (body: string) => ({ status: 200, bytes: new TextEncoder().encode(body), headers: {} });
let networkCalls = 0;

const transport = Layer.succeed(SourceHttp, { request: (url) => checkCaller.pipe(Effect.map(() => {
  networkCalls++;

  if (url === ORIGIN + "/api/publicToken") return encoded("eyJsynthetic.payload.signature");
  assert.equal(url, ORIGIN + "/api/v1/feed?last");

  return encoded(JSON.stringify({ id: cursor, items: [] }));
})) });

const services = SourceLive.pipe(Layer.provide(Layer.mergeAll(NavClientLive, AddressClientLive).pipe(Layer.provide(transport))));

const facets = Effect.scoped(Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-sqlite-resource-" });
  const a = yield* SqliteClient.make({ filename: join(directory, "a.db"), disableWAL: true });
  const b = yield* acquireSqliteResource({ filename: join(directory, "b.db") });
  yield* a`CREATE TABLE marker(label TEXT)`; yield* a`INSERT INTO marker VALUES ('A')`;
  yield* b`CREATE TABLE marker(label TEXT)`; yield* b`INSERT INTO marker VALUES ('B')`;
  yield* b`CREATE TABLE changes(label TEXT)`;

  const rolled = yield* Effect.either(a.withTransaction(Effect.gen(function* () {
    assert.equal(b.safe, b); assert.equal(b.withoutTransforms(), b);
    assert.doesNotThrow(() => b.updateValues([{ label: "example" }], "rows"));
    assert.deepEqual(yield* b`SELECT label FROM marker`, [{ label: "B" }]);
    assert.deepEqual(yield* b.unsafe("SELECT label FROM marker"), [{ label: "B" }]);
    assert.deepEqual(yield* b.unsafe("SELECT label FROM marker").values, [["B"]]);
    assert.deepEqual(yield* b.unsafe("SELECT label FROM marker").raw, [{ label: "B" }]);
    assert.deepEqual(yield* b.unsafe("SELECT label FROM marker").withoutTransform, [{ label: "B" }]);
    assert.deepEqual(yield* b.safe`SELECT label FROM marker`, [{ label: "B" }]);
    assert.deepEqual(yield* b.withoutTransforms()`SELECT label FROM marker`, [{ label: "B" }]);
    assert.deepEqual(yield* b`SELECT 42 AS n`.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [{ n: 42n }]);
    assert.deepEqual(yield* b.unsafe("SELECT 42 AS n").values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [[42n]]);
    assert.deepEqual(yield* b.unsafe("SELECT 42 AS n").raw.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [{ n: 42n }]);
    const reactive = yield* Stream.runCollect(b.reactive(["marker"], b`SELECT label FROM marker`).pipe(Stream.take(1)));
    assert.deepEqual(Array.from(reactive), [[{ label: "B" }]]);
    const reader = yield* acquireSqliteResource({ filename: join(directory, "b.db"), readonly: true, readwrite: false, create: false });
    yield* reader`PRAGMA query_only = 1`;
    const contender = new Database(join(directory, "b.db"), { create: false });
    let contenderHeld = false;

    try {
      contender.exec("PRAGMA busy_timeout = 0");
      yield* b.withTransaction(Effect.sync(() => {
        // Writer BEGIN must reserve the write lock before the first body statement.
        assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /locked|busy/i);
      }));
      contender.exec("BEGIN IMMEDIATE"); contenderHeld = true;
      contender.query("UPDATE marker SET label='uncommitted'").run();
      yield* reader.withConnection(reader.withTransaction(Effect.gen(function* () {
        yield* checkCaller;
        assert.deepEqual(yield* reader`SELECT label FROM marker`, [{ label: "B" }]);
        assert.deepEqual(yield* reader.withTransaction(reader`SELECT label FROM marker`), [{ label: "B" }]);
        assert.deepEqual(yield* readSnapshot(reader, reader`SELECT label FROM marker`), [{ label: "B" }]);
        const blocked = yield* Effect.either(reader.withTransaction(reader`INSERT INTO changes VALUES ('readonly-forbidden')`));
        assert(Either.isLeft(blocked)); assert.equal(blocked.left._tag, "SqlError");
        assert.deepEqual(yield* reader`SELECT label FROM marker`, [{ label: "B" }]);
        assert.equal((yield* reader`PRAGMA query_only`)[0]?.query_only, 1);
      })));
      contender.exec("ROLLBACK"); contenderHeld = false;
    } finally {
      if (contenderHeld) contender.exec("ROLLBACK");
      contender.close();
    }

    assert.equal((yield* a`PRAGMA query_only`)[0]?.query_only, 0);
    yield* Effect.scoped(Effect.gen(function* () {
      const connection = yield* b.reserve;
      assert.deepEqual(yield* connection.execute("SELECT label FROM marker", [], undefined), [{ label: "B" }]);
      assert.deepEqual(yield* connection.executeValues("SELECT label FROM marker", []), [["B"]]);
      assert.deepEqual(yield* connection.executeRaw("SELECT label FROM marker", []), [{ label: "B" }]);
    }));
    yield* withReservedConnection(b, b.withTransaction(Effect.gen(function* () {
      yield* b`INSERT INTO changes VALUES ('committed')`;
      yield* withReservedConnection(b, b`SELECT label FROM marker`);
      yield* Effect.scoped(Effect.gen(function* () {
        const connection = yield* b.reserve;
        assert.deepEqual(yield* connection.execute("SELECT label FROM marker", [], undefined), [{ label: "B" }]);
      }));
      const inner = yield* Effect.either(b.withTransaction(b`INSERT INTO changes VALUES ('inner-rollback')`.pipe(Effect.zipRight(Effect.fail("inner")))));
      assert(Either.isLeft(inner));
      yield* readSnapshot(b, b.withTransaction(b`INSERT INTO changes VALUES ('snapshot-rollback')`));
      assert.deepEqual(yield* b`SELECT label FROM changes`, [{ label: "committed" }]);
    })));

    const ownRollback = yield* Effect.either(b.withTransaction(Effect.gen(function* () {
      yield* b`INSERT INTO changes VALUES ('outer-rollback')`;
      yield* b.withTransaction(b`INSERT INTO changes VALUES ('inner-success')`);

      return yield* Effect.fail("own-rollback");
    })));

    assert(Either.isLeft(ownRollback));
    yield* a`INSERT INTO marker VALUES ('A-rollback')`;

    return yield* Effect.fail("foreign-rollback");
  })));

  assert(Either.isLeft(rolled)); assert.equal(rolled.left, "foreign-rollback");
  assert.deepEqual(yield* a`SELECT label FROM marker`, [{ label: "A" }]);
  assert.deepEqual(yield* b`SELECT label FROM changes`, [{ label: "committed" }]);
  // Reservation and nested savepoint release must leave the connection reusable.
  yield* b.withTransaction(b`INSERT INTO changes VALUES ('after-release')`);
}));

const publicOperations = (rawOuter: boolean) => Effect.scoped(Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-source-selected-" });
  const pathA = join(directory, "a.db"), pathB = join(directory, "b.db"), pathC = join(directory, "created-in-foreign-transaction.db");
  const source = yield* Source;
  yield* source.initialize(pathA); yield* source.initialize(pathB);
  const a = yield* acquireStore(pathA, "existing"), b = yield* acquireStore(pathB, "existing");

  for (const [sql, title, changed] of [[a, "A", "2026-11-14T12:00:00+00:00"], [b, "B", version]] as const) {
    yield* sql`INSERT INTO ads VALUES (${id},${changed},${changed},${changed},${title},'Firm','["Oslo"]','[]',0,NULL,'NAV')`;
    yield* sql`INSERT INTO versions VALUES (${id},${changed})`;
    yield* sql`INSERT INTO ad_detail_versions VALUES (${id},${changed},${changed})`;
    yield* sql`INSERT INTO ad_status_evidence VALUES (${id},${changed},'ACTIVE')`;
    yield* sql`INSERT INTO ad_application_deadlines VALUES (${id},${changed},NULL,0)`;
    yield* sql`INSERT INTO state VALUES ('caught_up','1')`;
    yield* sql`INSERT INTO state VALUES ('checked',${changed})`;
  }

  const historyPath = join(directory, "history.db");
  const history = yield* acquireStore(historyPath, "create");
  let acquired = 0, released = 0;

  const lock: SourceWriterLock["Type"] = { acquire: (selected) => Effect.acquireRelease(checkCaller.pipe(Effect.tap(() => Effect.sync(() => {
    assert.equal(selected, pathB); acquired++;
  }))), () => Effect.sync(() => { released++; })) };

  const outer = rawOuter ? yield* SqliteClient.make({ filename: pathA, create: false, disableWAL: true }) : a;

  const result = yield* Effect.either(outer.withTransaction(Effect.gen(function* () {
    const manifest = yield* source.readManifest(pathB, 10, now);
    assert.equal(manifest.ads[0]?.title, "B"); assert.equal(manifest.ads[0]?.changed, version);
    assert.equal((yield* outer`PRAGMA query_only`)[0]?.query_only, 0);
    const selected = yield* acquireStore(pathB, "readonly");
    assert.equal((yield* selected`PRAGMA database_list`)[0]?.file, pathB);
    assert.equal((yield* selected`PRAGMA query_only`)[0]?.query_only, 1);
    assert.equal((yield* selected`PRAGMA busy_timeout`)[0]?.timeout, 5000);

    const facts = yield* readSnapshot(selected, Effect.gen(function* () {
      yield* checkCaller;
      const tables = yield* sourceTables(selected);
      assert(tables.has("versions") && tables.has("ad_status_evidence") && tables.has("ad_application_deadlines"));

      return { ad: yield* readHistoricalAd(selected, id), version: yield* readVersion(selected, id), status: yield* readStatus(selected, id), deadline: yield* readApplicationDeadline(selected, id) };
    }));

    assert.equal(facts.ad?.title, "B"); assert.equal(facts.version, version);
    assert.deepEqual(facts.status, ["ACTIVE", version]); assert.deepEqual(facts.deadline, [version, null, 0]);

    const replay = NavClientReplay([{ url: "/api/v1/feedentry/" + id, kind: "detail", body: {
      uuid: id, status: "ACTIVE", sistEndret: version,
      ad_content: { uuid: id, updated: version, title: "B", employer: { name: "Firm" }, workLocations: [{ municipal: "Oslo" }], expires: null, description: "B review text." },
    } }]);

    const candidate = { id, version };
    const text = yield* fetchCurrentAdTexts({ databasePath: pathB, manifest: { candidates: [candidate] }, candidates: [candidate] }).pipe(Effect.provide(replay.layer));
    assert.equal(text.available[0]?.text, "B review text."); assert.equal(text.unavailable.length, 0);
    assert.deepEqual(yield* source.checkFresh(pathB, now, 3 * 86_400_000), [true, version]);
    assert.deepEqual(yield* source.checkFresh(pathB, now, Number.MAX_VALUE), [true, version]);
    yield* source.initialize(pathC);
    assert.deepEqual(yield* source.collect(pathB), { pages: 1, events: 0, caught_up: true });
    yield* source.refreshEvidence(pathB, { rankMissing: () => [], locationCandidates: () => [], insideJobs: () => [] }).pipe(Effect.provideService(SourceWriterLock, lock));
    assert.equal(acquired, 1); assert.equal(released, 1);
    const run = yield* beginObservationRun(history, now);
    assert.equal(yield* recordObservation(history, { runId: run, listingUuid: id, sourceChangedAt: version, observedAt: now }), "new");
    assert.equal((yield* outer`PRAGMA query_only`)[0]?.query_only, 0);
    yield* outer`INSERT INTO state VALUES ('outer-only','rollback')`;

    return yield* Effect.fail("rollback-A");
  })));

  assert(Either.isLeft(result)); assert.equal(result.left, "rollback-A");
  assert.equal((yield* source.readManifest(pathA, 10, now)).ads[0]?.title, "A");
  assert.equal((yield* sourceState(a))["outer-only"], undefined);
  assert.equal(Date.parse((yield* sourceState(b)).checked ?? ""), Date.parse(now));
  assert.equal((yield* getObservation(history, id))?.source_changed_at, version);
  assert.equal((yield* source.readManifest(pathC, 10, now)).listing_count, 0);

  // A WAL fixture permits an independent commit between four public projections.
  yield* b`PRAGMA journal_mode = WAL`;
  const second = new Database(pathB, { create: false });

  try {
    const reader = yield* acquireStore(pathB, "readonly");
    yield* outer.withTransaction(readSnapshot(reader, Effect.gen(function* () {
      assert.equal((yield* readHistoricalAd(reader, id))?.changed, version);
      second.exec("BEGIN IMMEDIATE");
      second.query("UPDATE versions SET changed='newer'").run();
      second.query("UPDATE ad_status_evidence SET changed='newer',status='STOPPED'").run();
      second.query("UPDATE ad_application_deadlines SET changed='newer',rolling=1").run();
      second.exec("COMMIT");
      assert.equal(yield* readVersion(reader, id), version);
      assert.deepEqual(yield* readStatus(reader, id), ["ACTIVE", version]);
      assert.deepEqual(yield* readApplicationDeadline(reader, id), [version, null, 0]);
    })));
    assert.equal(yield* readVersion(reader, id), "newer");
  } finally { second.close(); }
}));

const clocks = Effect.scoped(Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-source-clock-" });
  const path = join(directory, "source.db");
  const absent = join(directory, "must-not-create.db");
  const source = yield* Source;
  yield* source.initialize(path);
  const sql = yield* acquireStore(path, "existing");
  yield* sql`INSERT INTO ads VALUES (${id},${version},${version},${version},'Clock fixture','Firm','[]','[]',0,'2099-01-01T00:00:00+00:00','NAV')`;
  yield* sql`INSERT INTO versions VALUES (${id},${version})`;
  yield* sql`INSERT INTO ad_texts VALUES (${id},'Synthetic minimized text',${version},NULL)`;
  yield* sql`INSERT INTO ad_detail_versions VALUES (${id},${version},${version})`;
  yield* sql`INSERT INTO ad_status_evidence VALUES (${id},${version},'ACTIVE')`;
  yield* sql`INSERT INTO ad_application_deadlines VALUES (${id},${version},NULL,0)`;
  const before = yield* captureSourceDatabase(sql);
  const bytes = yield* fs.readFile(path);
  const schemaVersion = yield* sql`PRAGMA schema_version`;

  for (const clock of ["z", "2026-11-17T10:00:00", "2026-11-17T10qZ", "10000-01-01T00:00:00Z"]) {
    const rejected = yield* Effect.either(source.collect(path, { maxPages: 0, now: clock }));
    assert(Either.isLeft(rejected)); assert.equal(rejected.left._tag, "SourceError");
    assert.equal(yield* captureSourceDatabase(sql), before);
    assert.deepEqual(yield* fs.readFile(path), bytes);
    assert.deepEqual(yield* sql`PRAGMA schema_version`, schemaVersion);
  }

  assert(Either.isLeft(yield* Effect.either(source.collect(absent, { maxPages: 0, now: "z" }))));
  assert.equal(yield* fs.exists(absent), false);
  const replay = NavClientReplay([]);
  yield* Effect.gen(function* () {
    const client = yield* (yield* NavClient).session();
    const rejected = yield* Effect.either(sync(sql, client, ingestionRules, { maxPages: 0, now: "z" }));
    assert(Either.isLeft(rejected)); assert.equal(rejected.left._tag, "SourceError");
  }).pipe(Effect.provide(replay.layer));
  replay.assertConsumed();
  assert.equal(yield* captureSourceDatabase(sql), before);
  yield* sql`UPDATE ads SET expires='2026-11-17T10:30:00+00:00'`;
  assert.deepEqual(yield* source.collect(path, { maxPages: 0, now: "2026-11-17T12:00:00+02:00" }), { pages: 0, events: 0, caught_up: false });
  assert.equal((yield* sourceState(sql)).checked, "2026-11-17T10:00:00+00:00");
  assert.equal((yield* sql`SELECT * FROM ads`).length, 1);
  assert.equal((yield* sql`SELECT text FROM ad_texts`)[0]?.text, "Synthetic minimized text");
  assert.equal(networkCalls, 0);
}));

// These expiry-null regressions catch clocks that otherwise bypass matchesDetail's expiry check.
const invalidResolverClocks = ["z", "2026-11-17T10:00:00", "2026-11-17T10qZ", "10000-01-01T00:00:00Z"];
const resolverCandidates = [{ uuid: id }];
const resolverPolicy = { rankMissing: () => [], locationCandidates: () => resolverCandidates, insideJobs: () => [] };
let resolverNavCalls = 0, resolverAddressCalls = 0;

const resolverTransport = Layer.succeed(SourceHttp, { request: (url) => checkCaller.pipe(Effect.map(() => {
  if (url.startsWith(SUPPORTED_PROVIDER + "?")) {
    resolverAddressCalls++;

    return encoded(JSON.stringify({ metadata: { totaltAntallTreff: 1 }, adresser: [{ adressetekst: "Street 1", postnummer: "1234", representasjonspunkt: { epsg: "EPSG:4326", lat: 59.9, lon: 10.7 } }] }));
  }

  resolverNavCalls++;

  if (url === ORIGIN + "/api/publicToken") return encoded("eyJsynthetic.payload.signature");
  assert.equal(url, ORIGIN + "/api/v1/feedentry/" + id);

  return encoded(JSON.stringify({ uuid: id, status: "ACTIVE", sistEndret: version, ad_content: {
    uuid: id, updated: version, title: "Clock fixture", employer: { name: "Firm" }, expires: null,
    workLocations: [{ municipal: "Oslo", country: "NORGE", address: "Street 1", postalCode: "1234" }],
  } }));
})) });

const resolverServices = SourceLive.pipe(Layer.provideMerge(Layer.mergeAll(NavClientLive, AddressClientLive).pipe(Layer.provide(resolverTransport))));

const resolverClocks = (publicApi: boolean) => Effect.scoped(Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-resolver-clock-" });
  const path = join(directory, "source.db"), legacyPath = join(directory, "legacy.db");
  const missingParent = join(directory, "not-created"), missing = join(missingParent, "source.db");
  const source = yield* Source;
  yield* source.initialize(path);
  const sql = yield* acquireStore(path, "existing");
  yield* sql`INSERT INTO ads VALUES (${id},${version},${version},${version},'Clock fixture','Firm','["Oslo"]','[]',0,NULL,'NAV')`;
  yield* sql`INSERT INTO versions VALUES (${id},${version})`;
  yield* sql`INSERT INTO ad_detail_versions VALUES (${id},${version},${version})`;
  // A recognized old store would be upgraded if the public guard were too late.
  const legacy = yield* acquireStore(legacyPath, "create");
  const adsSchema = (yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type='table' AND name='ads'`)[0]?.sql;
  assert(adsSchema);
  yield* legacy.unsafe(adsSchema);
  const before = yield* captureSourceDatabase(sql), legacyBefore = yield* captureSourceDatabase(legacy);
  const bytes = yield* fs.readFile(path), legacyBytes = yield* fs.readFile(legacyPath);
  const schema = yield* sql`PRAGMA schema_version`, legacySchema = yield* legacy`PRAGMA schema_version`;
  let locks = 0, releases = 0, policies = 0, checkpoints = 0;
  const lock: SourceWriterLock["Type"] = { acquire: () => Effect.acquireRelease(Effect.sync(() => { locks++; }), () => Effect.sync(() => { releases++; })) };

  const policy = { ...resolverPolicy, locationCandidates: () => {
    policies++;

    return resolverCandidates;
  } };

  const checkpoint = () => Effect.sync(() => { checkpoints++; });
  const nav = yield* (yield* NavClient).session();
  const address = yield* (yield* AddressClient).session(nav.deadline);

  for (const clock of invalidResolverClocks) {
    const outcomes = publicApi
      ? [yield* Effect.either(source.resolve(path, policy, { now: clock, checkpoint }).pipe(Effect.provideService(SourceWriterLock, lock))),
        yield* Effect.either(source.resolve(legacyPath, policy, { now: clock, checkpoint }).pipe(Effect.provideService(SourceWriterLock, lock))),
        yield* Effect.either(source.resolve(missing, policy, { now: clock, checkpoint }).pipe(Effect.provideService(SourceWriterLock, lock)))]
      : [yield* Effect.either(resolveCandidates(sql, nav, address, resolverCandidates, 1, { now: clock, checkpoint }))];

    for (const rejected of outcomes) {
      if (Either.isRight(rejected)) console.log(JSON.stringify({ plannedBaselineCounterexample: true, publicApi, clock, result: rejected.right, resolverNavCalls, resolverAddressCalls }));
      assert(Either.isLeft(rejected)); assert.equal(rejected.left._tag, "SourceError");
      assert.equal(rejected.left.message, "Invalid NAV timestamp");
    }

    assert.equal(locks, 0); assert.equal(releases, 0); assert.equal(policies, 0); assert.equal(checkpoints, 0);
    assert.equal(resolverNavCalls, 0); assert.equal(resolverAddressCalls, 0);
    assert.equal(yield* fs.exists(missing), false); assert.equal(yield* fs.exists(missingParent), false);
    assert.equal(yield* captureSourceDatabase(sql), before); assert.equal(yield* captureSourceDatabase(legacy), legacyBefore);
    assert.deepEqual(yield* fs.readFile(path), bytes); assert.deepEqual(yield* fs.readFile(legacyPath), legacyBytes);
    assert.deepEqual(yield* sql`PRAGMA schema_version`, schema); assert.deepEqual(yield* legacy`PRAGMA schema_version`, legacySchema);
  }

  if (publicApi) {
    // Clock failure must also precede lookup of the required lock service.
    const rejected = yield* Effect.either(source.resolve(missing, policy, { now: "z" }));
    assert(Either.isLeft(rejected)); assert.equal(rejected.left.message, "Invalid NAV timestamp");
    assert.equal(yield* fs.exists(missingParent), false);
  } else {
    // Without the clock guard this real empty resource fails its SQL storage check instead.
    const empty = yield* acquireStore(join(directory, "empty.db"), "create");
    const rejected = yield* Effect.either(resolveCandidates(empty, nav, address, [], 1, { now: "z" }));
    assert(Either.isLeft(rejected)); assert.equal(rejected.left._tag, "SourceError");
    assert.equal(rejected.left.message, "Invalid NAV timestamp");
  }

  for (const selectedClock of [undefined, now, "2026-11-17T12:00:00.123456+02:00"]) {
    yield* sql`DELETE FROM ad_locations`;
    const options = selectedClock === undefined ? {} : { now: selectedClock };

    const result = publicApi
      ? yield* source.resolve(path, policy, options).pipe(Effect.provideService(SourceWriterLock, lock))
      : yield* resolveCandidates(sql, yield* (yield* NavClient).session(), yield* (yield* AddressClient).session(), resolverCandidates, 1, options);

    assert.equal(result.resolved, 1);
    const saved = (yield* sql<{ provenance: string }>`SELECT provenance FROM ad_locations WHERE uuid=${id}`)[0];

    assert(saved);
    assert.equal(JSON.parse(saved.provenance).retrieved_at, selectedClock?.includes("123456") ? "2026-11-17T10:00:00.123456+00:00" : "2026-11-17T10:00:00+00:00");
  }

  assert.equal(locks, publicApi ? 3 : 0); assert.equal(releases, locks);
})).pipe(Effect.provide(resolverServices));

const selected = process.argv[2];

assert(selected === "facets" || selected === "public-raw" || selected === "public-owned" || selected === "clocks" || selected === "resolve-public-clock" || selected === "resolve-direct-clock");

const program = Match.value(selected).pipe(
  Match.when("facets", () => facets),
  Match.when("clocks", () => clocks),
  Match.when("resolve-public-clock", () => resolverClocks(true)),
  Match.when("resolve-direct-clock", () => resolverClocks(false)),
  Match.when("public-raw", () => publicOperations(true)),
  Match.when("public-owned", () => publicOperations(false)),
  Match.exhaustive,
);

await Effect.runPromise(program.pipe(Effect.provide(services), Effect.provideService(Marker, "caller-preserved"), Effect.provide(BunContext.layer), Effect.provide(Reactivity.layer), Effect.provide(TestContext.TestContext)));

console.log(`${selected}: passed`);
