import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun owns SQLite; keep the Vitest host independent of its native driver.
const run = (body: string) => {
  const directory = mkdtempSync(join(tmpdir(), "snapshot-store-"));

  try {
    const result = spawnSync("bun", ["--eval", `
      import { strict as assert } from "node:assert";
      import { Database } from "bun:sqlite";
      import { readFileSync, writeFileSync, existsSync } from "node:fs";
      import { Effect, Either } from "effect";
      import { publishSnapshot, latestSnapshotRecord, readSnapshotRecord, SnapshotStore, SnapshotStoreLive } from "./src/lib/server/snapshot/store.ts";
      const path = process.env.SNAPSHOT_TEST_DIR + "/snapshot.db";
      const html = new TextEncoder().encode("<article>æ</article>");
      const shortlist = { profile_id: "owner", listing_ids: ["one", "two"] };
      const bytes = value => new TextEncoder().encode(JSON.stringify(value));
      const execute = effect => Effect.runPromise(effect);
      const fails = async effect => assert(Either.isLeft(await execute(Effect.either(effect))));
      const unchanged = async effect => {
        const before = readFileSync(path);
        await fails(effect);
        assert.deepEqual(readFileSync(path), before);
        for (const suffix of ["-wal", "-shm", "-journal"]) assert(!existsSync(path + suffix));
      };
      ${body}
    `], { encoding: "utf8", timeout: 20_000, env: { ...process.env, SNAPSHOT_TEST_DIR: directory } });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("SnapshotStore publishes one page-free row with oracle wire metadata and atomic retention", () => run(`
  const starred = { schema_version: 1, profile_id: "owner", jobs: [{ listing_id: "one", summary: {
    title: "Role", employer: null, deadline: null, expires_at: "2026-10-01T00:00:00+00:00",
    source_status: "active", source_version: "version", source_checked_at: null,
  } }] };
  const first = await execute(Effect.gen(function* () {
    const store = yield* SnapshotStore;
    return yield* store.publish(path, { html, shortlist, starred, publishedAt: "saved" });
  }).pipe(Effect.provide(SnapshotStoreLive)));
  assert.equal(first, 1);
  const record = await execute(readSnapshotRecord(path, "owner"));
  assert.equal(record.publishedAt, "saved");
  assert.deepEqual(record.html, html);
  assert.deepEqual(record.shortlist, shortlist);
  assert.deepEqual(record.starred, starred);
  assert.equal(record.dashboardBundle, null);
  assert.equal(record.dashboardJson, null);
  const db = new Database(path);
  assert.equal(db.query("SELECT dashboard_bundle FROM digest_snapshots").get().dashboard_bundle, null);
  const wire = db.query("SELECT shortlist_metadata, starred_metadata FROM digest_snapshots").get();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(wire.shortlist_metadata)), shortlist);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(wire.starred_metadata)), starred);
  db.close();
  await execute(publishSnapshot(path, { html, shortlist, keep: 1 }));
  const check = new Database(path, { readonly: true });
  assert.equal(check.query("SELECT count(*) AS count FROM digest_snapshots").get().count, 1);
  assert.equal(check.query("SELECT id FROM digest_snapshots").get().id, 2);
  check.close();
`));

test("SnapshotStore separates generic newest reads from explicit shortlist profile binding", () => run(`
  assert.equal(await execute(latestSnapshotRecord(path)), null);
  assert(!existsSync(path));
  await execute(publishSnapshot(path, { html }));
  assert.equal((await execute(latestSnapshotRecord(path))).shortlist, null);
  await unchanged(readSnapshotRecord(path, "owner"));
  await execute(publishSnapshot(path, { html, shortlist }));
  await unchanged(readSnapshotRecord(path, "other"));
  await unchanged(readSnapshotRecord(path, "INVALID"));
  assert.deepEqual((await execute(readSnapshotRecord(path, "owner"))).shortlist, shortlist);
`));

test("SnapshotStore migrates nullable legacy columns only on publish and preserves validated legacy bundle bytes", () => run(`
  const db = new Database(path);
  db.exec("CREATE TABLE digest_snapshots (id INTEGER PRIMARY KEY, published_at TEXT NOT NULL, html BLOB NOT NULL)");
  db.query("INSERT INTO digest_snapshots VALUES (1, 'legacy', ?)").run(html);
  db.close();
  const before = readFileSync(path);
  assert.equal((await execute(latestSnapshotRecord(path))).publishedAt, "legacy");
  assert.deepEqual(readFileSync(path), before);
  await execute(publishSnapshot(path, { html, shortlist }));
  const migrated = new Database(path);
  const names = migrated.query("PRAGMA table_info(digest_snapshots)").all().map(row => row.name);
  for (const name of ["dashboard_bundle", "shortlist_metadata", "starred_metadata", "dashboard_json"]) assert(names.includes(name));
  const bundle = bytes({ version: 1, views: { fit: "fit", evidence: "evidence", market: "market", calibrate: "calibrate", about: "about" } });
  migrated.query("UPDATE digest_snapshots SET dashboard_bundle = ? WHERE id = 2").run(bundle);
  migrated.close();
  assert.deepEqual((await execute(latestSnapshotRecord(path))).dashboardBundle, bundle);
  const invalid = new Database(path);
  invalid.query("UPDATE digest_snapshots SET dashboard_bundle = ? WHERE id = 2").run(bytes({ version: 1, views: { unexpected: "bad" } }));
  invalid.close();
  await fails(latestSnapshotRecord(path));
`));

test("SnapshotStore refuses feedback stores before writer acquisition", () => run(`
  const db = new Database(path);
  db.exec("CREATE TABLE shortlist_feedback (listing_id TEXT)");
  db.close();
  await unchanged(publishSnapshot(path, { html, shortlist }));
  const check = new Database(path, { readonly: true });
  assert.equal(check.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'digest_snapshots'").get().n, 0);
  check.close();
`));

test("SnapshotStore rejects invalid inputs before creating an output file", () => run(`
  for (const input of [
    { html: new Uint8Array([255]) }, { html: new Uint8Array(2000001) },
    ...[0, -1, 1.5, NaN, Infinity].map(keep => ({ html, keep })),
    { html, dashboardJson: bytes({}) },
    { html, shortlist: { profile_id: "owner", listing_ids: ["one", "one"] } },
    { html, shortlist: { profile_id: "Bad", listing_ids: [] } },
    { html, shortlist: { ...shortlist, extra: true } },
    { html, starred: { schema_version: 1, profile_id: "owner", jobs: [{ listing_id: "one", summary: {} }] } },
  ]) {
    await fails(publishSnapshot(path, input));
    assert(!existsSync(path));
  }
`));

test("SnapshotStore rolls back insertion and retention together", () => run(`
  await execute(publishSnapshot(path, { html, shortlist }));
  const db = new Database(path);
  db.exec("CREATE TRIGGER prevent_retention BEFORE DELETE ON digest_snapshots BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  db.close();
  await unchanged(publishSnapshot(path, { html, shortlist, keep: 1 }));
  const check = new Database(path, { readonly: true });
  assert.equal(check.query("SELECT count(*) AS n FROM digest_snapshots").get().n, 1);
  assert.equal(check.query("SELECT max(id) AS id FROM digest_snapshots").get().id, 1);
  check.close();
`));

test("SnapshotStore refuses corrupt, oversized, wrong-type and duplicate-key stored payloads without writes", () => run(`
  await execute(publishSnapshot(path, { html, shortlist }));
  const corruptions = [
    ["html = ?", "not a blob"], ["html = ?", new Uint8Array([255])],
    ["html = zeroblob(2000001)", null],
    ["shortlist_metadata = ?", bytes({ profile_id: "owner", listing_ids: ["one", "one"] })],
    ["shortlist_metadata = ?", new TextEncoder().encode('{"profile_id":"other","profile_id":"owner","listing_ids":[]}')],
    ["starred_metadata = ?", bytes({ schema_version: 1.0, profile_id: "owner", jobs: [], unexpected: true })],
    ["dashboard_json = ?", bytes({})],
    ["dashboard_bundle = zeroblob(10000000)", null],
  ];
  for (const [assignment, value] of corruptions) {
    const db = new Database(path);
    if (value === null) db.exec("UPDATE digest_snapshots SET " + assignment);
    else db.query("UPDATE digest_snapshots SET " + assignment).run(value);
    db.close();
    await unchanged(latestSnapshotRecord(path));
    const reset = new Database(path);
    reset.query("UPDATE digest_snapshots SET html = ?, shortlist_metadata = ?, starred_metadata = NULL, dashboard_json = NULL, dashboard_bundle = NULL").run(html, bytes(shortlist));
    reset.close();
  }
`));

test("SnapshotStore preserves valid dashboard JSON bytes without regenerating its contract", () => run(`
  const dashboardJson = readFileSync("tests/oracle/basic-run/snapshot/snapshot-v1.json");
  await execute(publishSnapshot(path, { html, shortlist, dashboardJson }));
  const before = readFileSync(path);
  const record = await execute(readSnapshotRecord(path, "owner"));
  assert.deepEqual(record.dashboardJson, Uint8Array.from(dashboardJson));
  assert.deepEqual(readFileSync(path), before);
`));

test("SnapshotStore rejects metadata integer floats, controls, unsorted jobs and newline identifiers", () => run(`
  const summary = { title: null, employer: null, deadline: null, expires_at: null,
    source_status: "unknown", source_version: null, source_checked_at: null };
  for (const bad of [
    { profile_id: "owner\\n", listing_ids: [] },
    { profile_id: "owner", listing_ids: ["one\\n"] },
  ]) {
    await fails(publishSnapshot(path, { html, shortlist: bad }));
    assert(!existsSync(path));
  }
  for (const jobs of [
    [{ listing_id: "b", summary }, { listing_id: "a", summary }],
    [{ listing_id: "a", summary: { ...summary, title: "bad\\u202e" } }],
    [{ listing_id: "a", summary: { ...summary, expires_at: "2026-02-30T00:00:00+00:00" } }],
  ]) {
    await fails(publishSnapshot(path, { html, starred: { schema_version: 1, profile_id: "owner", jobs } }));
    assert(!existsSync(path));
  }
  await execute(publishSnapshot(path, { html, shortlist }));
  const db = new Database(path);
  db.query("UPDATE digest_snapshots SET starred_metadata = ?").run(new TextEncoder().encode('{"schema_version":1.0,"profile_id":"owner","jobs":[]}'));
  db.close();
  await unchanged(latestSnapshotRecord(path));
`));

test("SnapshotStore rolls back nullable migrations when insertion fails", () => run(`
  const db = new Database(path);
  db.exec("CREATE TABLE digest_snapshots (id INTEGER PRIMARY KEY, published_at TEXT NOT NULL, html BLOB NOT NULL)");
  db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON digest_snapshots BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  db.close();
  await unchanged(publishSnapshot(path, { html, shortlist }));
  const check = new Database(path, { readonly: true });
  assert.deepEqual(check.query("PRAGMA table_info(digest_snapshots)").all().map(row => row.name), ["id", "published_at", "html"]);
  check.close();
`));

test("SnapshotStore treats empty stores as absent and malformed stores as errors", () => run(`
  const db = new Database(path); db.exec("CREATE TABLE unrelated (value TEXT)"); db.close();
  const before = readFileSync(path);
  assert.equal(await execute(latestSnapshotRecord(path)), null);
  assert.deepEqual(readFileSync(path), before);
  const incomplete = new Database(path); incomplete.exec("CREATE TABLE digest_snapshots (id INTEGER)"); incomplete.close();
  await unchanged(latestSnapshotRecord(path));
  writeFileSync(path, "not SQLite");
  await unchanged(latestSnapshotRecord(path));
`));
