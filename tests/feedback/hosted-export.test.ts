import { Database } from "bun:sqlite";
import { Effect, Either } from "effect";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_FEEDBACK_EVENTS, MAX_HOSTED_FEEDBACK_BYTES } from "../../src/lib/contracts/feedback-events.ts";
import { PhoneFeedbackEventsError, readHostedFeedbackEventsResponse } from "../../src/lib/server/feedback/phone-events.ts";
import { PHONE_FEEDBACK_DDL } from "../../src/lib/server/feedback/phone-store-schema.ts";

const profile = "invented";
const early = "2026-02-01T09:00:00+00:00";
const late = "2026-02-02T09:00:00+00:00";
const insert = "INSERT INTO shortlist_feedback VALUES (?, ?, ?, ?, ?)";
const failure = Either.left(new PhoneFeedbackEventsError({ message: "Phone feedback cannot be read" }));
let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pulse-hosted-export-"));
  path = join(directory, "selected.sqlite3");
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

const save = async (populate: (db: Database) => void, ddl = PHONE_FEEDBACK_DDL) => {
  const db = new Database(":memory:");

  try {
    db.run(ddl);
    populate(db);
    await writeFile(path, db.serialize(), { mode: 0o600, flag: "wx" });
  } finally { db.close(); }
};

const read = (selection = profile) => Effect.runPromise(readHostedFeedbackEventsResponse(path, selection));
const readEither = (selection = profile) => Effect.runPromise(Effect.either(readHostedFeedbackEventsResponse(path, selection)));
const empty = '{"schema":"pulse.feedback_events","schema_version":1,"profile_id":"invented","events":[]}';

test("hosted export emits exact compact bytes for all current controls in frozen event order", async () => {
  await save((db) => {
    db.run(insert, [profile, "a-later", 1, null, late]);
    db.run(insert, [profile, "z-both", 1, "up", early]);
    db.run(insert, [profile, "m-only", 0, "down", early]);
    db.run(insert, [profile, "cleared", 0, null, late]);
    db.run(insert, ["other", "not-selected", 1, "up", early]);
  });
  const before = await readFile(path);

  expect(new TextDecoder().decode(await read())).toBe(
    '{"schema":"pulse.feedback_events","schema_version":1,"profile_id":"invented","events":['
    + '{"event_id":"reaction:m-only:2026-02-01T09:00:00+00:00","listing_id":"m-only","source":"nav","source_version":null,"kind":"reaction","value":"down","reason":"","created_at":"2026-02-01T09:00:00+00:00","origin":"phone_shortlist","result_id":null},'
    + '{"event_id":"reaction:z-both:2026-02-01T09:00:00+00:00","listing_id":"z-both","source":"nav","source_version":null,"kind":"reaction","value":"up","reason":"","created_at":"2026-02-01T09:00:00+00:00","origin":"phone_shortlist","result_id":null},'
    + '{"event_id":"star:z-both:2026-02-01T09:00:00+00:00","listing_id":"z-both","source":"nav","source_version":null,"kind":"star","value":true,"reason":"","created_at":"2026-02-01T09:00:00+00:00","origin":"phone_shortlist","result_id":null},'
    + '{"event_id":"star:a-later:2026-02-02T09:00:00+00:00","listing_id":"a-later","source":"nav","source_version":null,"kind":"star","value":true,"reason":"","created_at":"2026-02-02T09:00:00+00:00","origin":"phone_shortlist","result_id":null}]}',
  );
  expect(new TextDecoder().decode(await read("absent"))).toBe(empty.replace('"invented"', '"absent"'));
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(["selected.sqlite3"]);
});

test("missing and nonmatching schemas fail generically without initialization", async () => {
  expect(await readEither()).toEqual(failure);
  expect(await readdir(directory)).toEqual([]);
  await save(() => undefined, "CREATE TABLE unrelated (value TEXT)");
  const before = await readFile(path);
  expect(await readEither()).toEqual(failure);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(["selected.sqlite3"]);
});

test.each([
  ["bad.id", 0, null, early],
  ["bad-star", 2, null, early],
  ["bad-reaction", 0, "yes", early],
  ["bad-cleared-time", 0, null, "2026-02-30T09:00:00+00:00"],
])("a malformed selected row (%s) refuses the whole response", async (id, starred, reaction, stamp) => {
  await save((db) => {
    db.run(insert, [profile, "aaa-valid", 1, null, early]);
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(insert, [profile, id, starred, reaction, stamp]);
  });
  expect(await readEither()).toEqual(failure);
  expect(await readEither("' OR 1=1 --")).toEqual(failure);
  expect(new TextDecoder().decode(await read("absent"))).toBe(empty.replace('"invented"', '"absent"'));
});

const saveMany = (count: number, listingLength: number, starred: number) => save((db) => {
  const add = db.query(insert);

  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      add.run(profile, String(index).padStart(listingLength, "0"), starred, null, early);
    }
  })();
});

test.each([MAX_FEEDBACK_EVENTS, MAX_FEEDBACK_EVENTS + 1])("counts %i source rows even when all controls are cleared", async (count) => {
  await saveMany(count, 5, 0);

  if (count === MAX_FEEDBACK_EVENTS) expect(new TextDecoder().decode(await read())).toBe(empty);
  else expect(await readEither()).toEqual(failure);
});

test.each([4_000, 5_000])("enforces the byte budget independently of the source row count (%i long IDs)", async (count) => {
  await saveMany(count, 128, 1);

  if (count === 4_000) {
    const bytes = await read();
    expect(bytes.byteLength).toBeGreaterThan(1_900_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_HOSTED_FEEDBACK_BYTES);
    expect(new TextDecoder().decode(bytes)).toContain(`star:${"3999".padStart(128, "0")}:${early}`);
  } else expect(await readEither()).toEqual(failure);
});
