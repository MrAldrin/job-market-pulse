import { BunContext } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Effect, Either } from "effect";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { PhoneFeedbackEventsError, readPhoneFeedbackEvents } from "../../src/lib/server/feedback/phone-events.ts";
import { PhoneFeedbackStore, phoneFeedbackStoreLayer, type PhoneFeedbackUpdate } from "../../src/lib/server/feedback/phone-store.ts";
import starEvents from "../oracle/viewer-api/feedback/star-events.json";
import reactionEvents from "../oracle/viewer-api/feedback/reaction-events.json";
import reactionClearEvents from "../oracle/viewer-api/feedback/reaction-clear-events.json";
import unstarEvents from "../oracle/viewer-api/feedback/unstar-events.json";

const listing = "00000000-0000-0000-0000-000000000001";
const stamp = "2026-10-19T12:00:00+00:00";

const withPath = async (testCase: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-phone-events-"));

  try { await testCase(join(directory, "shortlist.sqlite3")); }
  finally { await rm(directory, { recursive: true }); }
};

const read = (path: string, profileId = "invented") => Effect.runPromise(
  readPhoneFeedbackEvents(path, profileId).pipe(Effect.provide(BunContext.layer)),
);

const update = (path: string, change: PhoneFeedbackUpdate) => Effect.runPromise(
  Effect.flatMap(PhoneFeedbackStore, (store) => store.update("invented", listing, change)).pipe(
    Effect.provide(phoneFeedbackStoreLayer(path)), Effect.provide(FixedOsloClock),
  ),
);

test("matches the saved oracle at each step of the current-controls sequence without writing on reads", () => withPath(async (path) => {
  const steps: readonly (readonly [PhoneFeedbackUpdate, unknown])[] = [
    [{ field: "starred", value: true }, starEvents],
    [{ field: "reaction", value: "up" }, reactionEvents],
    [{ field: "reaction", value: null }, reactionClearEvents],
    [{ field: "starred", value: false }, unstarEvents],
  ];

  for (const [change, expected] of steps) {
    await update(path, change);
    const before = await readFile(path);

    expect(await read(path)).toEqual(expected);
    expect(await read(path, "other")).toEqual([]);
    expect(await readFile(path)).toEqual(before);
  }
}));

test("reads past a batch of cleared controls and retains only controls for the selected profile", () => withPath(async (path) => {
  await update(path, { field: "starred", value: true });
  const db = new Database(path, { create: false });

  try {
    const insert = db.prepare("INSERT INTO shortlist_feedback VALUES (?,?,?,?,?)");
    db.transaction(() => {
      for (let index = 0; index < 500; index++) insert.run("invented", `a-${index}`, 0, null, stamp);
      insert.run("invented", "z-last", 0, "down", stamp);
      insert.run("other", "z-last", 1, "up", stamp);
    })();
  } finally {
    // Finalize prepared statements before closing so Windows can remove the database.
    db.close(true);
  }

  expect(await read(path)).toEqual([...starEvents, {
    event_id: `reaction:z-last:${stamp}`, listing_id: "z-last", source: "nav", source_version: null,
    kind: "reaction", value: "down", reason: "", created_at: stamp, origin: "phone_shortlist", result_id: null,
  }]);
}));

test("missing store returns no events, but an existing wrong schema does not get initialized", () => withPath(async (path) => {
  expect(await read(path)).toEqual([]);
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "", { mode: 0o600 });
  const result = await Effect.runPromise(readPhoneFeedbackEvents(path, "invented").pipe(Effect.either, Effect.provide(BunContext.layer)));

  expect(result).toEqual(Either.left(new PhoneFeedbackEventsError({ message: "Phone feedback cannot be read" })));
  expect((await lstat(path)).size).toBe(0);
}));
