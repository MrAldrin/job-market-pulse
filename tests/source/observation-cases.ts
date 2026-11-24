import { Reactivity } from "@effect/experimental";
import { Cause, Context, Effect, Either, Exit, Layer, Option, Predicate, Schema } from "effect";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import creates from "../fixtures/source/observation-schema.json";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observation, ObservationRun, RunObservation, assignUnscopedHistory, beginObservationRun, getCurrentObservationRun, getObservation, initializeObservationSchema, listRunObservations, recordObservation } from "../../src/lib/server/source/observations.ts";
import type { SourceSql } from "../../src/lib/server/source/store.ts";
import { acquireSqliteResource } from "../../src/lib/server/shared/sqlite-resource.ts";

class TestStore extends Context.Tag("tests/source/ObservationStore")<TestStore, SourceSql>() {}

const dir = await mkdtemp(join(tmpdir(), "pulse-observations-"));
const a = "00000000-0000-0000-0000-000000000001";
const b = "00000000-0000-0000-0000-000000000002";
const t = "2026-10-15T12:00:00Z";
const normalized = "2026-10-15T12:00:00+00:00";
const early = "2026-10-15T11:00:00Z";
const late = "2026-10-15T13:00:00Z";

const fail = <A, E, R>(program: Effect.Effect<A, E, R>, tag = "ObservationError") => Effect.gen(function* () {
  const result = yield* Effect.exit(program);
  assert(Exit.isFailure(result));
  const failure = Cause.failureOption(result.cause);
  assert.equal(failure._tag, "Some", Cause.pretty(result.cause));

  if (Option.isSome(failure)) assert(Predicate.isTagged(failure.value, tag));
});

const record = (sql: SourceSql, runId: number, listingUuid = a, sourceChangedAt = "v1", observedAt = t, profileId: string | null = null) => recordObservation(sql, { runId, listingUuid, sourceChangedAt, observedAt, profileId });
const snapshot = (sql: SourceSql) => sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;

// The fixture retains historical SQL schemas for migration tests.
const seed = (sql: SourceSql, version: number) => Effect.gen(function* () {
  yield* sql.unsafe(creates[0]!);
  yield* sql`INSERT INTO observation_schema VALUES (1,${version})`;

  if (version === 0) return;
  yield* sql.unsafe(creates[1]!);
  yield* sql`INSERT INTO observations VALUES (${a},'v1','2026-10-15T14:00:00+02:00','2026-10-15T12:00:00.123456Z')`;

  if (version === 1) return;

  for (const statement of creates.slice(2, 5)) yield* sql.unsafe(statement);
  yield* sql`INSERT INTO observation_runs VALUES (1,'2026-10-15T14:00:00+02:00')`;
  yield* sql`INSERT INTO run_observations VALUES (1,${a},'v1','2026-10-15T14:00:00+02:00','new')`;
});

const withStore = <A, E>(name: string, program: Effect.Effect<A, E, TestStore>, readonly = false) => Effect.runPromise(Effect.provide(program, Layer.scoped(TestStore, acquireSqliteResource({ filename: join(dir, name), create: !readonly, readonly, readwrite: !readonly })).pipe(Layer.provide(Reactivity.layer))));

const migrations = async () => {
  for (const version of [0, 1, 2]) {
    const name = `v${version}.sqlite`;
    await withStore(name, Effect.gen(function* () {
      const sql = yield* TestStore;
      yield* seed(sql, version);
      yield* initializeObservationSchema(sql);
      const before = yield* snapshot(sql);
      yield* initializeObservationSchema(sql);
      assert.deepEqual(yield* snapshot(sql), before);
      assert.equal((yield* sql<{ version: number }>`SELECT version FROM observation_schema`)[0]?.version, 3);
      const tables = new Map(before.map((row) => [row.name, row.sql]));
      // SQLite removes IF NOT EXISTS from sqlite_master and appends added columns.
      assert.equal(tables.get("observation_schema"), creates[0]!.replace(" IF NOT EXISTS", ""));
      assert.equal(tables.get("observations"), creates[5]);
      assert.equal(tables.get("run_baselines"), creates[3]);
      assert.equal(tables.get("observation_runs"), creates[2]!.slice(0, -1) + ", profile_id TEXT)");
      assert.equal(tables.get("run_observations"), creates[4]!.replace("'previously_seen')),", "'previously_seen')), profile_id TEXT,"));
      assert.equal((yield* sql<{ user_version: number }>`PRAGMA user_version`)[0]?.user_version, 0);
      assert.equal((yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`)[0]?.journal_mode, "delete");

      if (version > 0) {
        assert.equal((yield* getObservation(sql, a))?.first_seen_at, normalized);
        assert.equal((yield* getObservation(sql, a))?.last_seen_at, "2026-10-15T12:00:00.123456+00:00");
        const runId = yield* beginObservationRun(sql, t);
        assert.equal(yield* record(sql, runId), "previously_seen");
      }
    }));
    await withStore(name, Effect.gen(function* () {
      const sql = yield* TestStore;

      if (version > 0) assert.notEqual(yield* getObservation(sql, a), null);
      const before = yield* snapshot(sql);
      yield* getCurrentObservationRun(sql);
      assert.deepEqual(yield* snapshot(sql), before);
    }), true);
  }
};

const legacy = async () => {
  for (const version of [1, 2]) {
    const name = `legacy${version}.sqlite`;
    await withStore(name, Effect.gen(function* () { yield* seed(yield* TestStore, version); }));
    await withStore(name, Effect.gen(function* () {
      const sql = yield* TestStore;
      const before = yield* snapshot(sql);
      assert.equal((yield* getObservation(sql, a))?.first_seen_at, normalized);
      assert.equal(yield* getObservation(sql, a, "alice"), null);
      assert.equal(yield* getCurrentObservationRun(sql, "alice"), null);
      yield* fail(listRunObservations(sql, 1, { profileId: "alice" }));

      if (version === 2) {
        assert.deepEqual(yield* getCurrentObservationRun(sql), { run_id: 1, started_at: normalized });
        assert.equal((yield* listRunObservations(sql, 1))[0]?.observed_at, normalized);
      }

      assert.deepEqual(yield* snapshot(sql), before);
      assert.equal((yield* sql<{ version: number }>`SELECT version FROM observation_schema`)[0]?.version, version);
    }), true);
  }

  await withStore("empty.sqlite", Effect.void);
  await withStore("empty.sqlite", Effect.gen(function* () {
    const sql = yield* TestStore;
    assert.equal(yield* getObservation(sql, a, "alice"), null);
    assert.equal(yield* getCurrentObservationRun(sql, "alice"), null);
    yield* fail(getObservation(sql, a), "SqlError");
    yield* fail(getCurrentObservationRun(sql), "SqlError");
    assert.deepEqual(yield* snapshot(sql), []);
  }), true);
};

const refusals = async () => {
  for (const value of [-1, 4, 1.5, "invalid"]) await withStore(`bad${value}.sqlite`, Effect.gen(function* () {
    const sql = yield* TestStore;
    yield* sql`CREATE TABLE observation_schema (singleton INTEGER PRIMARY KEY, version)`;
    yield* sql`INSERT INTO observation_schema VALUES (1,${value})`;
    const before = yield* snapshot(sql);
    yield* fail(initializeObservationSchema(sql));
    assert.deepEqual(yield* snapshot(sql), before);
    assert.equal((yield* sql<{ version: unknown }>`SELECT version FROM observation_schema`)[0]?.version, value);
  }));
  await withStore("real-version.sqlite", Effect.gen(function* () {
    const sql = yield* TestStore;
    yield* sql`CREATE TABLE observation_schema (singleton INTEGER PRIMARY KEY, version)`;
    yield* sql`INSERT INTO observation_schema VALUES (1,1.0)`;
    yield* fail(initializeObservationSchema(sql));
    assert.equal((yield* snapshot(sql)).length, 1);
  }));
  await withStore("unknown.sqlite", Effect.gen(function* () {
    const sql = yield* TestStore;
    yield* sql`CREATE TABLE ads (uuid TEXT PRIMARY KEY)`;
    const before = yield* snapshot(sql);
    yield* fail(initializeObservationSchema(sql));
    assert.deepEqual(yield* snapshot(sql), before);
  }));
  await withStore("feedback.sqlite", Effect.gen(function* () {
    const sql = yield* TestStore;
    yield* sql`CREATE TABLE feedback (id INTEGER PRIMARY KEY)`;
    yield* sql`CREATE TABLE proposals (id INTEGER PRIMARY KEY)`;
    yield* sql`CREATE TABLE proposal_evidence (proposal_id INTEGER, feedback_id INTEGER)`;
    yield* initializeObservationSchema(sql);
  }));
};

const history = () => withStore("history.sqlite", Effect.gen(function* () {
  const sql = yield* TestStore;
  const first = yield* beginObservationRun(sql, t);
  assert.equal(yield* record(sql, first), "new");
  assert.equal(yield* record(sql, first, a, "v2", late), "new");
  assert.equal((yield* listRunObservations(sql, first))[0]?.source_changed_at, "v1");
  assert.equal((yield* listRunObservations(sql, first))[0]?.observed_at, normalized);
  const second = yield* beginObservationRun(sql, early);
  assert.equal(yield* record(sql, second, a, "v2", early), "previously_seen");
  assert.equal(yield* record(sql, second, a, "v3", early), "previously_seen");
  assert.equal(yield* record(sql, first, a, "old", "2026-10-15T15:00:00Z"), "new");
  assert.deepEqual(yield* getObservation(sql, a), { listing_uuid: a, source_changed_at: "v3", first_seen_at: "2026-10-15T11:00:00+00:00", last_seen_at: "2026-10-15T15:00:00+00:00" });
  const third = yield* beginObservationRun(sql, t);
  assert.equal(yield* record(sql, third, a, "v4"), "changed");
  assert.equal(yield* record(sql, third, b), "new");
  assert.equal((yield* listRunObservations(sql, third, { status: "changed" }))[0]?.listing_uuid, a);
  assert.deepEqual((yield* listRunObservations(sql, third, { limit: 1, offset: 1 })).map((row) => row.listing_uuid), [b]);
  assert.deepEqual(yield* listRunObservations(sql, third, { offset: 2 }), []);
  const absent = yield* beginObservationRun(sql, t);
  assert.deepEqual(yield* listRunObservations(sql, absent), []);
  const returned = yield* beginObservationRun(sql, t);
  assert.equal(yield* record(sql, returned, a, "v4"), "previously_seen");
  assert(Either.isRight(Schema.decodeUnknownEither(Observation)(yield* getObservation(sql, a))));
  assert(Either.isRight(Schema.decodeUnknownEither(ObservationRun)(yield* getCurrentObservationRun(sql))));
  assert(Either.isRight(Schema.decodeUnknownEither(RunObservation)((yield* listRunObservations(sql, returned))[0])));
}));

const profiles = () => withStore("profiles.sqlite", Effect.gen(function* () {
  const sql = yield* TestStore;
  const legacyRun = yield* beginObservationRun(sql, t);
  yield* record(sql, legacyRun);
  const alice = yield* beginObservationRun(sql, t, "alice");
  const bob = yield* beginObservationRun(sql, t, "bob");
  assert.equal(yield* record(sql, alice, a, "v1", t, "alice"), "new");
  assert.equal(yield* record(sql, bob, a, "v1", t, "bob"), "new");
  yield* record(sql, alice, b, "v1", t, "alice");
  yield* fail(listRunObservations(sql, alice, { profileId: "bob" }));
  yield* fail(record(sql, alice, b, "v2", t, "bob"));
  assert.equal((yield* getCurrentObservationRun(sql, "alice"))?.run_id, alice);
  assert.equal((yield* getCurrentObservationRun(sql, "bob"))?.run_id, bob);
  assert.equal(yield* getCurrentObservationRun(sql, "carol"), null);
  const before = yield* sql`SELECT * FROM observations ORDER BY profile_scope,listing_uuid`;
  const runs = yield* sql`SELECT * FROM observation_runs ORDER BY run_id`;
  const captured = yield* sql`SELECT * FROM run_observations ORDER BY run_id,listing_uuid`;
  yield* fail(assignUnscopedHistory(sql, "alice"));
  assert.deepEqual(yield* sql`SELECT * FROM observations ORDER BY profile_scope,listing_uuid`, before);
  assert.deepEqual(yield* sql`SELECT * FROM observation_runs ORDER BY run_id`, runs);
  assert.deepEqual(yield* sql`SELECT * FROM run_observations ORDER BY run_id,listing_uuid`, captured);
  assert.equal(yield* assignUnscopedHistory(sql, "carol"), 1);
  assert.equal(yield* assignUnscopedHistory(sql, "carol"), 0);
  assert.equal(yield* getObservation(sql, a), null);
  assert.equal(yield* getCurrentObservationRun(sql), null);
  assert.equal((yield* listRunObservations(sql, legacyRun, { profileId: "carol" }))[0]?.listing_uuid, a);
  const next = yield* beginObservationRun(sql, t, "alice");
  assert.equal(yield* record(sql, next, a, "v1", t, "alice"), "previously_seen");
}));

const invalids = () => withStore("invalids.sqlite", Effect.gen(function* () {
  const sql = yield* TestStore;

  for (const id of ["", "Bad Id", "UPPER", "a--b", "../x", "a".repeat(65), 4]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(beginObservationRun(sql, t, id as string));
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(getObservation(sql, a, id as string));
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(getCurrentObservationRun(sql, id as string));
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(assignUnscopedHistory(sql, id as string));
  }

  yield* fail(assignUnscopedHistory(sql, null));

  for (const time of ["2026-10-15T12:00:00", "bad", null, 3]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(beginObservationRun(sql, time as string));
  }

  assert.deepEqual(yield* snapshot(sql), []);
  const runId = yield* beginObservationRun(sql, t);

  for (const id of ["not-a-uuid", "", null, 3]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(record(sql, runId, id as string));
  }

  for (const value of ["", " v1", "v1\u001c", "v1\u0085", "v\n1", null, 3, false]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(record(sql, runId, a, value as string));
  }

  // Python strip does not treat BOM or zero-width space as whitespace.
  assert.equal(yield* record(sql, runId, a, "\ufeffv1\ufeff"), "new");
  assert.equal(yield* record(sql, runId, a, "\u200bv1\u200b"), "new");

  for (const id of [0, -1, 1.5, true, "1", NaN]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(record(sql, id as number));
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(listRunObservations(sql, id as number));
  }

  for (const limit of [0, 1001, 1.5, true, null, "2"]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(listRunObservations(sql, runId, { limit: limit as number }));
  }

  for (const offset of [-1, 1.5, true, null, "0"]) {
    // SAFETY: Deliberately violate the public type to test runtime rejection.
    yield* fail(listRunObservations(sql, runId, { offset: offset as number }));
  }

  // SAFETY: Deliberately violate the public type to test runtime rejection.
  yield* fail(listRunObservations(sql, runId, { status: "invalid" as "new" }));
  yield* fail(listRunObservations(sql, 999));
  yield* fail(record(sql, 999));

  for (const id of [a.replaceAll("-", ""), `{${a}}`, `urn:uuid:${a}`, a.toUpperCase()]) assert.notEqual(yield* getObservation(sql, id), null);
  assert.equal(yield* record(sql, runId, `{${a.replaceAll("-", "")}}`), "new");
  const letters = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  assert.equal(yield* record(sql, runId, `urn:uuid:{${letters.toUpperCase()}}`, "v1", "2026-10-15T14:00:00.123456+02:00"), "new");
  assert.equal((yield* getObservation(sql, letters))?.first_seen_at, "2026-10-15T12:00:00.123456+00:00");
  assert.equal((yield* listRunObservations(sql, runId, { status: null })).length, 2);

  for (const time of ["2026-10-15T12:00:00", "invalid"]) yield* fail(record(sql, runId, a, "v1", time));
  // SAFETY: Deliberately violate the object boundary to check typed failure, not a defect.
  yield* fail(recordObservation(sql, null as never));
  // SAFETY: Deliberately violate the options boundary to check typed failure, not a defect.
  yield* fail(listRunObservations(sql, runId, null as never));
}));

const atomicity = () => withStore("atomicity.sqlite", Effect.gen(function* () {
  const sql = yield* TestStore;
  yield* initializeObservationSchema(sql);
  yield* sql`BEGIN`;
  const rolled = yield* beginObservationRun(sql, t);
  yield* record(sql, rolled);
  yield* fail(record(sql, rolled, b, ""));
  yield* sql`ROLLBACK`;
  assert.equal(yield* getObservation(sql, a), null);
  yield* fail(listRunObservations(sql, rolled));
  // An error after the observations upsert must roll that upsert back too.
  const first = yield* beginObservationRun(sql, t);
  yield* sql`CREATE TRIGGER reject_capture BEFORE INSERT ON run_observations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`;
  yield* fail(record(sql, first), "SqlError");
  assert.equal(yield* getObservation(sql, a), null);
  assert.deepEqual(yield* listRunObservations(sql, first), []);
  yield* sql`DROP TRIGGER reject_capture`;
  yield* sql.withTransaction(Effect.gen(function* () {
    const nested = yield* beginObservationRun(sql, t);
    assert.equal(yield* record(sql, nested), "new");
  }));
  const ids = yield* Effect.all(Array.from({ length: 12 }, () => beginObservationRun(sql, t)), { concurrency: 6 });
  assert.equal(new Set(ids).size, 12);
  const statuses = yield* Effect.all(ids.map((id) => record(sql, id, b, `v${id}`)), { concurrency: 6 });
  assert(statuses.every((status) => status === "new"));
  assert.equal((yield* getObservation(sql, b))?.source_changed_at, `v${Math.max(...ids)}`);

  for (const id of ids) assert.equal((yield* listRunObservations(sql, id)).length, 1);
}));

const cases = { migrations, legacy, refusals, history, profiles, invalids, atomicity };

try {
  const selected = Schema.decodeUnknownEither(Schema.Literal("migrations", "legacy", "refusals", "history", "profiles", "invalids", "atomicity"))(process.argv[2]);
  assert(Either.isRight(selected), "Expected a named observation case");
  await cases[selected.right]();
  console.log(`observation ${selected.right}: passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
