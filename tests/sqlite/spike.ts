import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat, writeFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const errorCode = <A>(exit: Exit.Exit<A, SqlError>) => {
  assert(Exit.isFailure(exit));
  const failure = Cause.failureOption(exit.cause);
  assert(Option.isSome(failure));

  return Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(failure.value.cause).code;
};

const now = () => performance.timeOrigin + performance.now();
const exists = async (path: string) => access(path).then(() => true, () => false);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const layer = (filename: string, readonly = false) => SqliteClient.layer({ filename, readonly, create: !readonly, readwrite: !readonly, disableWAL: true });

const run = <A, E>(filename: string, program: Effect.Effect<A, E, SqliteClient.SqliteClient>, readonly = false) =>
  Effect.runPromise(Effect.provide(program, layer(filename, readonly)));

const waitFor = async (path: string) => {
  for (let i = 0; i < 1000; i++) { if (await exists(path)) return; await pause(10); }

  throw new Error(`Timed out waiting for ${path}`);
};

const [mode, dbPath, control] = process.argv.slice(2);

if (mode === "writer" && dbPath && control) {
  const records: { start: number; end: number; result: string; seq: number }[] = [];
  await run(dbPath, Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql`PRAGMA busy_timeout = 100`;
    yield* sql`PRAGMA wal_autocheckpoint = 0`;
    let seq = 0;

    while (!(yield* Effect.promise(() => exists(`${control}.stop`)))) {
      const start = now();
      const exit = yield* Effect.exit(sql`INSERT INTO events (seq, payload) VALUES (${++seq}, ${"writer-sentinel"})`);
      records.push({ start, end: now(), result: Exit.isSuccess(exit) ? "committed" : errorCode(exit), seq });

      if (seq === 1) yield* Effect.promise(() => writeFile(`${control}.ready`, "ready"));
      yield* Effect.promise(() => pause(2));
    }
  }));
  await writeFile(`${control}.records`, JSON.stringify(records));
} else if (mode === "lock" && dbPath && control) {
  await run(dbPath, Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql`BEGIN IMMEDIATE`;
    yield* Effect.promise(() => writeFile(`${control}.ready`, "ready"));
    yield* Effect.promise(() => pause(1000));
    yield* sql`ROLLBACK`;
  }));
} else {
  const dir = await mkdtemp(join(tmpdir(), "pulse-sqlite-spike-"));
  const db = join(dir, "source.db");
  const snapshot = join(dir, `snapshot-${crypto.randomUUID()}.db`);
  const ctl = join(dir, "writer");
  const child = (kind: string, marker: string) => Bun.spawn([process.execPath, import.meta.path, kind, db, marker], { stdout: "inherit", stderr: "inherit" });
  let activeChild: ReturnType<typeof Bun.spawn> | undefined;

  try {
    const missing = join(dir, "missing.db");
    const missingExit = await Effect.runPromiseExit(Effect.provide(Effect.gen(function* () { yield* SqliteClient.SqliteClient; }), layer(missing, true)));
    assert(Exit.isFailure(missingExit));
    assert.equal(await exists(missing), false);
    await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`PRAGMA page_size = 8192`;
      yield* sql`PRAGMA auto_vacuum = 2`;
      yield* sql`PRAGMA user_version = 37`;
      yield* sql`PRAGMA application_id = 123456789`;
      yield* sql`CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      yield* sql`CREATE TABLE bulk (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
      yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40000) INSERT INTO bulk SELECT x, hex(randomblob(1024)) FROM n`;
    }));
    await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      assert.equal((yield* sql<{ count: number }>`SELECT count(*) AS count FROM bulk`)[0]?.count, 40000);
      const write = yield* Effect.exit(sql`INSERT INTO events VALUES (0, 'no')`);
      assert.equal(errorCode(write), "SQLITE_READONLY");
    }), true);
    const lockCtl = join(dir, "lock");
    const locker = child("lock", lockCtl);
    activeChild = locker;
    await waitFor(`${lockCtl}.ready`);

    const contention = await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`PRAGMA busy_timeout = 150`;
      const setting = (yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0];
      const start = now();
      const exit = yield* Effect.exit(sql`INSERT INTO events VALUES (0, 'locked')`);
      const elapsedMs = now() - start;
      assert.equal(errorCode(exit), "SQLITE_BUSY");
      assert.equal(setting?.timeout, 150);
      assert(elapsedMs >= 120 && elapsedMs < 900);

      return { setting, elapsedMs, error: errorCode(exit) };
    }));

    assert.equal(await locker.exited, 0);

    const queryOnly = await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`PRAGMA query_only = ON`;
      const setting = yield* sql`PRAGMA query_only`;
      const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM bulk`;
      const exit = yield* Effect.exit(sql`INSERT INTO events VALUES (0, 'forbidden')`);
      assert.equal(errorCode(exit), "SQLITE_READONLY"); assert.equal(rows[0]?.count, 40000);
      assert.deepEqual(setting, [{ query_only: 1 }]);

      return { setting, error: errorCode(exit) };
    }));

    const writer = child("writer", ctl);
    activeChild = writer;
    await waitFor(`${ctl}.ready`);
    await pause(100);
    const walBytes = (await stat(`${db}-wal`)).size;
    assert(walBytes > 32);

    const result = await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      const start = now();
      yield* sql`VACUUM INTO ${snapshot}`;
      const end = now();
      const existsExit = yield* Effect.exit(sql`VACUUM INTO ${snapshot}`);
      assert.equal(errorCode(existsExit), "SQLITE_ERROR");

      return { start, end, targetExistsError: errorCode(existsExit) };
    }));

    await pause(100);
    await writeFile(`${ctl}.stop`, "stop");
    assert.equal(await writer.exited, 0);
    const record = Schema.Struct({ start: Schema.Number, end: Schema.Number, result: Schema.String, seq: Schema.Int });
    const records = Schema.decodeUnknownSync(Schema.parseJson(Schema.Array(record)))(await Bun.file(`${ctl}.records`).text());
    const committed = records.filter((r) => r.result === "committed");
    const before = committed.filter((r) => r.end < result.start);
    const during = committed.filter((r) => r.start >= result.start && r.end <= result.end);
    const after = committed.filter((r) => r.start > result.end);
    assert(before.length && during.length && after.length);

    const inspect = (path: string) => run(path, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      const quick = yield* sql`PRAGMA quick_check`;
      const page = yield* sql`PRAGMA page_size`;
      const user = yield* sql`PRAGMA user_version`;
      const app = yield* sql`PRAGMA application_id`;
      const auto = yield* sql`PRAGMA auto_vacuum`;
      const events = yield* sql<{ count: number; max: number; min: number }>`SELECT count(*) AS count, max(seq) AS max, min(seq) AS min FROM events WHERE payload = 'writer-sentinel'`;
      const bulk = yield* sql<{ count: number }>`SELECT count(*) AS count FROM bulk`;

      return { quick, page, user, app, auto, events, bulk };
    }), true);

    const source = await inspect(db);
    const copy = await inspect(snapshot);
    assert.deepEqual(copy.quick, [{ quick_check: "ok" }]);
    assert.equal(copy.bulk[0]?.count, 40000);
    assert(copy.events[0] && copy.events[0].count > 0 && copy.events[0].min === 1 && copy.events[0].count === copy.events[0].max);
    assert(copy.events[0].max >= before.at(-1)!.seq && copy.events[0].max <= source.events[0]!.max);
    const metadata = { source: { page: source.page, user: source.user, app: source.app, auto: source.auto }, copy: { page: copy.page, user: copy.user, app: copy.app, auto: copy.auto } };

    const latency = (items: typeof records) => {
      const values = items.map((r) => r.end - r.start).sort((a, b) => a - b);

      return { count: values.length, medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
    };

    const sqlite = await run(db, Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;

      return yield* sql`SELECT sqlite_version() AS version`;
    }), true);

    const evidence = {
      bun: Bun.version,
      sqlite,
      contention,
      queryOnly,
      walBytes,
      vacuum: { ...result, durationMs: result.end - result.start },
      writer: {
        before: latency(before),
        during: latency(during),
        after: latency(after),
        errors: records.filter((r) => r.result !== "committed"),
        maxLatencyMs: Math.max(...records.map((r) => r.end - r.start)),
        records,
      },
      source,
      copy,
      metadata,
    };

    await mkdir("local_only", { recursive: true });
    await writeFile("local_only/bun-sqlite-spike.json", JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, writer: { ...evidence.writer, records: undefined } }, null, 2));
    assert.deepEqual(metadata.copy, metadata.source, "VACUUM metadata differs; see local evidence");
    assert.deepEqual(metadata.source, { page: [{ page_size: 8192 }], user: [{ user_version: 37 }], app: [{ application_id: 123456789 }], auto: [{ auto_vacuum: 2 }] });
  } finally {
    if (activeChild && activeChild.exitCode === null) { activeChild.kill(); await activeChild.exited; }

    await rm(dir, { recursive: true, force: true });
  }
}
