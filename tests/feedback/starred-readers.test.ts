import { Database } from "bun:sqlite";
import { Effect, Either } from "effect";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PHONE_FEEDBACK_DDL } from "../../src/lib/server/feedback/phone-store-schema.ts";
import { buildStarredJobsResponse } from "../../src/lib/server/feedback/starred-jobs.ts";
import { readSelectedStars } from "../../src/lib/server/feedback/starred-reader.ts";
import { readLatestStarredMetadata } from "../../src/lib/server/snapshot/store.ts";
import oracle from "../oracle/viewer-api/viewer/starred-export.json";
import { setFixturePublicRead } from "../orchestration/windows-acl-fixture.ts";

const profile = "invented";
const listing = "00000000-0000-0000-0000-000000000001";
const instant = "2026-10-19T12:00:00+00:00";
const snapshotDdl = "CREATE TABLE digest_snapshots (id INTEGER PRIMARY KEY, published_at TEXT NOT NULL, starred_metadata BLOB)";

const metadata = {
  schema_version: 1, profile_id: profile, jobs: [{ listing_id: listing, summary: {
    title: "Software developer", employer: "Invented Works", deadline: null,
    expires_at: "2099-01-01T00:00:00+00:00", source_status: "unknown",
    source_version: "2026-10-19T10:00:00+00:00", source_checked_at: null,
  } }],
};

let directory: string;
let phone: string;
let snapshot: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pulse-starred-readers-"));
  phone = join(directory, "phone.sqlite3");
  snapshot = join(directory, "snapshot.sqlite3");
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

const fixtureBytes = (setup: (db: Database) => void) => {
  const db = new Database(":memory:");

  try {
    setup(db);

    return db.serialize();
  } finally { db.close(); }
};

const save = (path: string, setup: (db: Database) => void) => writeFile(path, fixtureBytes(setup), { flag: "wx", mode: 0o600 });
const stars = () => readSelectedStars(phone, profile);
const newest = () => readLatestStarredMetadata(snapshot);

const phoneFixture = (db: Database) => {
  db.run(PHONE_FEEDBACK_DDL);
  db.run("INSERT INTO shortlist_feedback VALUES (?, ?, ?, ?, ?)", [profile, listing, 1, null, instant]);
};

const snapshotFixture = (db: Database) => {
  db.run(snapshotDdl);
  db.run("INSERT INTO digest_snapshots VALUES (?, ?, ?)", [9_007_199_254_740_992n, instant, Buffer.from("invalid older metadata")]);
  db.run("INSERT INTO digest_snapshots VALUES (?, ?, ?)", [9_007_199_254_740_993n, instant, Buffer.from(JSON.stringify(metadata))]);
};

test("the two owning readers reproduce the frozen v1 body and do not change either file", async () => {
  await save(phone, phoneFixture);
  await save(snapshot, snapshotFixture);
  // The approved snapshot-only exception permits broader mode bits.
  await chmod(snapshot, 0o644);

  const before = await Promise.all([readFile(phone), readFile(snapshot), readdir(directory)]);
  const [selected, capture] = await Effect.runPromise(Effect.all([stars(), newest()]));

  const result = Either.getOrThrow(buildStarredJobsResponse({
    source_instance: "invented-instance", profile_id: profile, exported_at: instant, stars: selected, snapshot: capture,
  }));

  expect(Buffer.from(result).toString("hex")).toBe(oracle.response.body.$bytes_hex);
  expect(await Promise.all([readFile(phone), readFile(snapshot), readdir(directory)])).toEqual(before);

  if (process.platform !== "win32") expect((await lstat(snapshot)).mode & 0o777).toBe(0o644);
});

test("selects every star for one profile, sorted, without consulting a snapshot", async () => {
  await save(phone, (db) => {
    phoneFixture(db);
    const insert = db.prepare("INSERT INTO shortlist_feedback VALUES (?, ?, ?, ?, ?)");
    insert.run(profile, "z-older", 1, "down", "2026-10-18T12:00:00+00:00");
    insert.run(profile, "cleared", 0, "up", instant);
    insert.run("another", "other-star", 1, "up", instant);
  });

  expect(await Effect.runPromise(stars())).toEqual([
    { listing_id: listing, starred: 1n, reaction: null, updated_at: instant },
    { listing_id: "z-older", starred: 1n, reaction: "down", updated_at: "2026-10-18T12:00:00+00:00" },
  ]);
  expect(await Effect.runPromise(readSelectedStars(phone, "no-stars"))).toEqual([]);
  await expect(lstat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("exports a committed star before the phone database checkpoints", async () => {
  await save(phone, phoneFixture);
  const writer = new Database(phone);

  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer.run("INSERT INTO shortlist_feedback VALUES (?, ?, 1, NULL, ?)", [profile, "new-star", instant]);
    const exported = await Effect.runPromise(stars());

    expect(exported.map((row) => row.listing_id)).toEqual([listing, "new-star"]);
  } finally { writer.close(); }
});

test("missing and invalid phone stores are refused without initialization, unlike an empty star set", async () => {
  await expect(Effect.runPromise(stars())).rejects.toThrow("Starred-jobs source is unavailable");
  await expect(lstat(phone)).rejects.toMatchObject({ code: "ENOENT" });
  await save(phone, (db) => db.run("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"));
  const before = await readFile(phone);

  await expect(Effect.runPromise(stars())).rejects.toThrow("Starred-jobs source is unavailable");
  expect(await readFile(phone)).toEqual(before);
});

test("refuses a phone store with extra objects, malformed current data, or more than 1000 stars", async () => {
  const cases = [
    (db: Database) => db.run("CREATE TABLE other (id INTEGER)"),
    (db: Database) => db.run("UPDATE shortlist_feedback SET updated_at = '2026-02-30T12:00:00+00:00'"),
    (db: Database) => db.run(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      INSERT INTO shortlist_feedback SELECT ?, printf('invented-%04d', n), 1, NULL, ? FROM seq`, [profile, instant]),
  ];

  for (const [index, change] of cases.entries()) {
    const path = join(directory, `refuse-${index}.sqlite3`);
    await save(path, (db) => { phoneFixture(db); change(db); });
    const before = await readFile(path);

    await expect(Effect.runPromise(readSelectedStars(path, profile))).rejects.toThrow("Starred-jobs source is unavailable");
    expect(await readFile(path)).toEqual(before);
  }
});

test("Snapshot reads only metadata, preserving missing and legacy capture behavior", async () => {
  const legacy = join(directory, "legacy.sqlite3");
  const empty = join(directory, "empty.sqlite3");

  expect(await Effect.runPromise(newest())).toBeNull();
  await expect(lstat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  await save(empty, (db) => db.run(snapshotDdl));
  expect(await Effect.runPromise(readLatestStarredMetadata(empty))).toBeNull();
  await save(legacy, (db) => {
    db.run("CREATE TABLE digest_snapshots (id INTEGER PRIMARY KEY, published_at TEXT NOT NULL)");
    db.run("INSERT INTO digest_snapshots VALUES (1, ?)", [instant]);
  });
  expect(await Effect.runPromise(readLatestStarredMetadata(legacy))).toEqual({ publishedAt: instant, starred: null });
  await save(snapshot, (db) => {
    snapshotFixture(db);
    db.run("ALTER TABLE digest_snapshots ADD COLUMN dashboard_json BLOB");
    db.run("UPDATE digest_snapshots SET dashboard_json = X'FF'");
  });
  expect(await Effect.runPromise(newest())).toEqual({ publishedAt: instant, starred: metadata });
});

test("Snapshot refuses corrupt, wrong-type or over-limit metadata without falling back", async () => {
  const cases = [
    "missing table",
    "text instead of blob",
    "over-limit blob",
    "duplicate keys",
    "floating version",
    "wrong latest timestamp",
    "duplicate selected rows",
  ];

  for (const [index, scenario] of cases.entries()) {
    const path = join(directory, `bad-snapshot-${index}.sqlite3`);
    await save(path, (db) => {
      if (scenario === "missing table") return db.run("CREATE TABLE unrelated (id INTEGER)");

      if (scenario === "duplicate selected rows") {
        db.run("CREATE TABLE digest_snapshots (id INTEGER, published_at TEXT NOT NULL, starred_metadata BLOB)");
        db.run("INSERT INTO digest_snapshots VALUES (2, ?, ?), (2, ?, zeroblob(2097153))", [instant, Buffer.from(JSON.stringify(metadata)), instant]);

        return;
      }

      db.run(snapshotDdl);
      db.run("INSERT INTO digest_snapshots VALUES (1, ?, ?)", [instant, Buffer.from(JSON.stringify(metadata))]);

      if (scenario === "over-limit blob") return db.run("INSERT INTO digest_snapshots VALUES (2, ?, zeroblob(2097153))", [instant]);

      if (scenario === "wrong latest timestamp") return db.run("INSERT INTO digest_snapshots VALUES (2, 'bad-time', NULL)");

      const payload = JSON.stringify(metadata);

      const invalid = scenario === "text instead of blob" ? payload
        : Buffer.from(scenario === "duplicate keys" ? payload.replace('"schema_version":1', '"schema_version":1,"schema_version":1') : payload.replace('"schema_version":1', '"schema_version":1.0'));

      db.run("INSERT INTO digest_snapshots VALUES (2, ?, ?)", [instant, invalid]);
    });

    await expect(Effect.runPromise(readLatestStarredMetadata(path)), scenario).rejects.toThrow("Starred snapshot metadata is unavailable");
  }
});

test("private feedback permissions and the file size limit remain in force", async () => {
  await save(phone, phoneFixture);
  await setFixturePublicRead(phone, true);
  await expect(Effect.runPromise(stars())).rejects.toThrow("Starred-jobs source is unavailable");

  if (process.platform !== "win32") expect((await lstat(phone)).mode & 0o777).toBe(0o644);
  await setFixturePublicRead(phone, false);
  await truncate(phone, 32 * 1024 * 1024 + 1);
  await expect(Effect.runPromise(stars())).rejects.toThrow("Starred-jobs source is unavailable");
});
