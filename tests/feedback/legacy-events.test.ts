import { BunContext } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Effect, Either } from "effect";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LegacyFeedbackError, readLegacyFeedbackEvents } from "../../src/lib/server/feedback/legacy-events.ts";

const stamp = "2026-01-02T12:00:00+00:00";

const ddl = `CREATE TABLE feedback (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL,
  ad_id TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('good','bad','unsure')),
  reason TEXT NOT NULL, assessment_version TEXT NOT NULL,
  preference_version TEXT NOT NULL, created_at TEXT NOT NULL)`;

const withPath = async (testCase: (path: string, directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-legacy-verdicts-"));

  const name = process.platform === "win32" ? "legacy %#.sqlite3" : "legacy ?#.sqlite3";

  try { await testCase(join(directory, name), directory); }
  finally { await rm(directory, { recursive: true }); }
};

const populate = (path: string, statements: string) => {
  const db = new Database(path);

  try { db.exec(statements); } finally { db.close(); }
};

const read = (path: string, includeUnassigned = false) => Effect.runPromise(
  readLegacyFeedbackEvents(path, "invented", includeUnassigned).pipe(Effect.provide(BunContext.layer)),
);

const verdict = (id: string, reason = "") => ({
  event_id: `legacy_verdict:${id}`, listing_id: "invented-job", source: "nav", source_version: null,
  kind: "legacy_verdict", value: "good", reason, created_at: stamp, origin: "legacy_review", result_id: null,
});

test("reads only assigned verdicts or explicitly included unassigned verdicts, without changing the store", () => withPath(async (path, directory) => {
  populate(path, `${ddl}; ALTER TABLE feedback ADD COLUMN profile_id TEXT; PRAGMA user_version=2;
    INSERT INTO feedback VALUES (1,'nav','invented-job','good','unassigned','a','p','${stamp}',NULL),
      (2,'nav','invented-job','good','','a','p','${stamp}','invented'),
      (3,'nav','invented-job','good','other profile','a','p','${stamp}','another'),
      (9007199254740993,'nav','invented-job','good','large row id','a','p','${stamp}','invented');`);
  const before = await readFile(path);
  const files = await readdir(directory);

  expect(await read(path)).toEqual([verdict("2"), verdict("9007199254740993", "large row id")]);
  expect(await read(path, true)).toEqual([verdict("1", "unassigned"), verdict("2"), verdict("9007199254740993", "large row id")]);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(files);
}));

test("an unscoped legacy layout needs opt-in and is not migrated", () => withPath(async (path) => {
  populate(path, `${ddl}; PRAGMA user_version=1;
    INSERT INTO feedback VALUES (1,'nav','invented-job','good','','a','p','${stamp}');`);
  const before = await readFile(path);

  expect(await read(path)).toEqual([]);
  expect(await read(path, true)).toEqual([verdict("1")]);
  expect(await readFile(path)).toEqual(before);
}));

test("an absent file or table supplies no events and does not initialize storage", () => withPath(async (path) => {
  expect(await read(path)).toEqual([]);
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  populate(path, "CREATE TABLE run_observations (id INTEGER PRIMARY KEY)");
  const before = await readFile(path);

  expect(await read(path, true)).toEqual([]);
  expect(await readFile(path)).toEqual(before);
}));

test("an invalid store fails without leaking the path or changing the store", () => withPath(async (path) => {
  const contents = "not sqlite";
  await writeFile(path, contents);
  const result = await Effect.runPromise(readLegacyFeedbackEvents(path, "invented").pipe(Effect.either, Effect.provide(BunContext.layer)));

  expect(result).toEqual(Either.left(new LegacyFeedbackError({ message: "Legacy feedback cannot be read" })));
  expect(await readFile(path, "utf8")).toBe(contents);
}));
