import { Database } from "bun:sqlite";
import { Effect, Either, Option, TestClock } from "effect";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { PhoneFeedbackStore, phoneFeedbackStoreLayer, type PhoneFeedbackUpdate } from "../../src/lib/server/feedback/phone-store.ts";
import { PhoneFeedbackInputError, PhoneFeedbackStoreError } from "../../src/lib/server/feedback/phone-store-schema.ts";
import golden from "../oracle/viewer-api/feedback/phone-store.json";

const listing = "00000000-0000-0000-0000-000000000001";
const defaults = { starred: false, reaction: null, updated_at: null };
const stamp = "2026-10-19T12:00:00+00:00";
const later = "2026-10-19T12:00:02+00:00";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pulse-phone-store-"));
  path = join(directory, "shortlist.sqlite3");
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

const run = <A, E>(program: Effect.Effect<A, E, PhoneFeedbackStore>, selected = path) => Effect.runPromise(
  program.pipe(Effect.provide(phoneFeedbackStoreLayer(selected)), Effect.provide(FixedOsloClock)),
);

const read = (profile: string, ids: readonly string[]) => Effect.flatMap(PhoneFeedbackStore, (store) => store.read(profile, ids));
const update = (change: PhoneFeedbackUpdate) => Effect.flatMap(PhoneFeedbackStore, (store) => store.update("invented", listing, change));
const setStar = update({ field: "starred", value: true });

const inspect = <A>(use: (db: Database) => A, readonly = true) => {
  const db = new Database(path, { readonly, create: false });

  try { return use(db); } finally { db.close(); }
};

const expectStoreError = async <A>(program: Effect.Effect<A, PhoneFeedbackInputError | PhoneFeedbackStoreError, PhoneFeedbackStore>, message: string, selected = path) => {
  const result = await run(Effect.either(program), selected);
  expect(Either.getLeft(result)).toEqual(Option.some(new PhoneFeedbackStoreError({ message })));
};

const expectUnavailable = async (selected: string) => {
  await expectStoreError(read("invented", [listing]), "Feedback store is unavailable", selected);
  await expectStoreError(setStar, "Feedback store is unavailable", selected);
};

describe("phone shortlist feedback store", () => {
  it("reproduces the viewer recorder's complete phone-store schema and final rows", async () => {
    // Frozen recorder sequence: star, react up, clear the reaction, unstar.
    const updates: readonly PhoneFeedbackUpdate[] = [
      { field: "starred", value: true }, { field: "reaction", value: "up" },
      { field: "reaction", value: null }, { field: "starred", value: false },
    ];

    await run(Effect.forEach(updates, update));

    const actual = inspect((db) => {
      const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master").values();
      const columns = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(shortlist_feedback)").all();

      return {
        present: true,
        schema_objects: schema,
        integrity_check: db.query("PRAGMA integrity_check").values(),
        foreign_key_check: db.query("PRAGMA foreign_key_check").values(),
        tables: { shortlist_feedback: {
          columns: columns.map((column) => column.name),
          primary_key: columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
          rows: db.query("SELECT * FROM shortlist_feedback ORDER BY profile_id, listing_id").values(),
          sql: schema[0]?.[3],
        } },
        user_version: db.query("PRAGMA user_version").values()[0]?.[0],
      };
    });

    expect(actual).toEqual(golden);
  });

  it("validates identifiers before touching a file and leaves empty reads file-free", async () => {
    expect(await run(read("invented", []))).toEqual(new Map());

    for (const result of await run(Effect.forEach([
      read("a--b", []), read("a\n", []), read("invented", ["a\n"]), read("invented", ["a", "a"]),
      read("invented", ["a".repeat(129)]), read("invented", Array.from({ length: 66_667 }, (_, i) => `job-${i}`)),
    ], Effect.either))) {
      expect(Option.getOrUndefined(Either.getLeft(result))).toBeInstanceOf(PhoneFeedbackInputError);
    }

    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns ordered defaults from a new private file, including object-key-like IDs", async () => {
    const ids = [listing, "__proto__", "constructor"];
    expect(await run(read("invented", ids))).toEqual(new Map(ids.map((id) => [id, defaults])));
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("persists across opens, preserves the other field and isolates profiles and batches", async () => {
    const states = await run(Effect.gen(function* () {
      const first = yield* setStar;
      yield* TestClock.adjust("2 seconds");
      const retry = yield* setStar;
      const reaction = yield* update({ field: "reaction", value: "down" });
      const reactionRetry = yield* update({ field: "reaction", value: "down" });

      return { first, retry, reaction, reactionRetry };
    }));

    expect(states.first).toEqual({ ...defaults, starred: true, updated_at: stamp });
    expect(states.retry).toEqual(states.first);
    expect(states.reaction).toEqual({ ...states.first, reaction: "down", updated_at: later });
    expect(states.reactionRetry).toEqual(states.reaction);
    const ids = [...Array.from({ length: 1_200 }, (_, index) => `job-${index}`), listing];
    const saved = await run(read("invented", ids));
    expect([...saved.keys()]).toEqual(ids);
    expect(saved.get(listing)).toEqual(states.reaction);
    expect(saved.get("job-0")).toEqual(defaults);
    expect((await run(read("partner", [listing]))).get(listing)).toEqual(defaults);
  });

  it("opens the existing frozen DDL and preserves concurrent sets of different fields", async () => {
    await writeFile(path, "", { mode: 0o600 });
    inspect((db) => db.exec(golden.tables.shortlist_feedback.sql), false);
    await run(Effect.all([setStar, update({ field: "reaction", value: "up" })], { concurrency: 2 }));
    expect((await run(read("invented", [listing]))).get(listing)).toEqual({ starred: true, reaction: "up", updated_at: stamp });
  });

  it("initializes a row when its first explicit set is already the default", async () => {
    expect(await run(update({ field: "reaction", value: null }))).toEqual({ ...defaults, updated_at: stamp });
    expect((await run(read("invented", [listing]))).get(listing)).toEqual({ ...defaults, updated_at: stamp });
  });

  it("refuses directory, missing-parent and corrupt-file paths with a sanitized error", async () => {
    await mkdir(path);
    await expectUnavailable(path);
    await expectUnavailable(join(directory, "absent", "feedback.sqlite3"));
    const corrupt = join(directory, "corrupt");
    await writeFile(corrupt, "not sqlite", { mode: 0o600 });
    await expectUnavailable(corrupt);
    expect(await readFile(corrupt, "utf8")).toBe("not sqlite");
  });

  it.each([
    "CREATE TABLE shortlist_feedback (profile_id TEXT, listing_id TEXT, starred INTEGER, reaction TEXT, updated_at TEXT)",
    "CREATE INDEX extra_index ON shortlist_feedback (starred)",
  ])("refuses invalid schema %s without migration", async (ddl) => {
    if (ddl.startsWith("CREATE INDEX")) await run(setStar);
    else await writeFile(path, "", { mode: 0o600 });
    inspect((db) => db.exec(ddl), false);
    const original = await readFile(path);
    await expectStoreError(read("invented", [listing]), "Feedback store schema is invalid");
    await expectStoreError(setStar, "Feedback store schema is invalid");
    expect(await readFile(path)).toEqual(original);
  });

  it("validates persisted rows and rolls back a write that would return an invalid timestamp", async () => {
    await run(setStar);

    const invalidWrite = await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("0000-01-01T00:00:00Z"));

      return yield* Effect.either(update({ field: "reaction", value: "up" }));
    }));

    expect(Either.getLeft(invalidWrite)).toEqual(Option.some(new PhoneFeedbackStoreError({ message: "Feedback store row is invalid" })));
    expect((await run(read("invented", [listing]))).get(listing)).toEqual({ ...defaults, starred: true, updated_at: stamp });

    inspect((db) => db.exec("UPDATE shortlist_feedback SET updated_at = '2026-02-30T12:00:00+00:00'"), false);
    await expectStoreError(read("invented", [listing]), "Feedback store row is invalid");
  });
});
