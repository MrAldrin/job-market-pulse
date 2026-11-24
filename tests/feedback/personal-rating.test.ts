import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clock, Effect, Either } from "effect";
import type { JudgeDatabaseHandle } from "../../src/lib/server/judge/database.ts";
import type { PersonalRatingInput } from "../../src/lib/server/feedback/personal-rating.ts";

// The last real v1 schema (6d0f7cd5a2d1^), not the oracle's skeletal migration test.
const frozenV1 = [
  `CREATE TABLE personal_feedback_schema ( profile_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version > 0) )`,
  `CREATE TABLE personal_ratings ( id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source = 'nav'), ad_id TEXT NOT NULL, source_version TEXT NOT NULL, rating TEXT NOT NULL CHECK(rating IN ('very_good', 'good', 'unsure', 'bad', 'very_bad')), reason TEXT NOT NULL, result_id TEXT, input_fingerprint TEXT, profile_fingerprint TEXT, preferences_fingerprint TEXT, rules_fingerprint TEXT, scoring_version TEXT, review_prompt_version TEXT, created_at TEXT NOT NULL, UNIQUE(profile_id, id) )`,
  `CREATE INDEX personal_ratings_latest ON personal_ratings(profile_id, source, ad_id, id DESC)`,
  `CREATE TABLE calibration_runs ( id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, created_at TEXT NOT NULL, request_fingerprint TEXT NOT NULL, profile_fingerprint TEXT NOT NULL, preferences_fingerprint TEXT NOT NULL, rules_fingerprint TEXT NOT NULL, scoring_version TEXT NOT NULL, review_prompt_version TEXT NOT NULL, calibration_prompt_version TEXT NOT NULL, UNIQUE(profile_id, id) )`,
  `CREATE TABLE calibration_run_evidence ( profile_id TEXT NOT NULL, run_id INTEGER NOT NULL, rating_id INTEGER NOT NULL, result_id TEXT, source_version TEXT NOT NULL, input_fingerprint TEXT, PRIMARY KEY(profile_id, run_id, rating_id), FOREIGN KEY(profile_id, run_id) REFERENCES calibration_runs(profile_id, id), FOREIGN KEY(profile_id, rating_id) REFERENCES personal_ratings(profile_id, id) )`,
  `CREATE TABLE calibration_proposals ( id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, run_id INTEGER NOT NULL, target TEXT NOT NULL CHECK(target IN ('preferences', 'review_prompt')), base_target_version TEXT NOT NULL, proposed_target_version TEXT NOT NULL, proposed_text TEXT NOT NULL, diff_text TEXT NOT NULL, rationale TEXT NOT NULL, uncertainty TEXT NOT NULL, regression_notes TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(profile_id, id), FOREIGN KEY(profile_id, run_id) REFERENCES calibration_runs(profile_id, id) )`,
  `CREATE TABLE calibration_proposal_evidence ( profile_id TEXT NOT NULL, proposal_id INTEGER NOT NULL, rating_id INTEGER NOT NULL, PRIMARY KEY(profile_id, proposal_id, rating_id), FOREIGN KEY(profile_id, proposal_id) REFERENCES calibration_proposals(profile_id, id), FOREIGN KEY(profile_id, rating_id) REFERENCES personal_ratings(profile_id, id) )`,
  `CREATE TABLE calibration_proposal_events ( id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, proposal_id INTEGER NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('proposed', 'approved', 'rejected', 'applied', 'stale')), created_at TEXT NOT NULL, owner_confirmed INTEGER NOT NULL CHECK(owner_confirmed IN (0, 1)), resulting_version TEXT, note TEXT NOT NULL DEFAULT '', FOREIGN KEY(profile_id, proposal_id) REFERENCES calibration_proposals(profile_id, id) )`,
];

// SHA-256 of the frozen v2 sqlite_schema SQL (explicit objects only, sorted, LF-joined).
const freshV2Hash = "e7cc1aec3053747074118590b1ad53bdb9010e6bab17e1d9f55f1d8ff76d3571";

const example = {
  profile_id: "synthetic",
  ad_id: "00000000-0000-0000-0000-000000000001",
  source_version: "nav-test-v1",
  rating: "good",
} as const satisfies PersonalRatingInput;

const timestamp = "2026-01-01T00:00:00+00:00";
const fixedClock = (nanos: bigint) => Object.assign(Clock.make(), { currentTimeNanos: Effect.succeed(nanos) });
const dayClock = fixedClock(BigInt(Date.parse(timestamp)) * 1_000_000n);

const runCases = async () => {
  const { BunFileSystem } = await import("@effect/platform-bun");
  const { openJudgeDatabase } = await import("../../src/lib/server/judge/database.ts");
  const { appendPersonalRating, readPersonalRatingEvents } = await import("../../src/lib/server/feedback/personal-rating.ts");

  type Case = (state: JudgeDatabaseHandle) => Effect.Effect<void, { readonly message: string }>;

  const run = async (test: Case) => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-synthetic-ratings-"));
    const selection = { profile_id: example.profile_id, directory, path: join(directory, "state.sqlite3"), readonly: false, require_existing: false };

    try {
      await Effect.runPromise(Effect.scoped(Effect.flatMap(openJudgeDatabase(selection), test)).pipe(
        Effect.provide(BunFileSystem.layer), Effect.withClock(dayClock),
      ));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const snapshot = (state: JudgeDatabaseHandle) => Effect.gen(function* () {
    const sql = state.sql;

    return {
      objects: yield* sql<{ name: string; sql: string | null }>`SELECT name, sql FROM main.sqlite_schema ORDER BY name`,
      version: yield* sql`PRAGMA schema_version`,
      userVersion: yield* sql`PRAGMA user_version`,
    };
  });

  const rejects = <A>(program: Effect.Effect<A, { readonly message: string }>, pattern: RegExp) => Effect.gen(function* () {
    const result = yield* Effect.either(program);
    assert(Either.isLeft(result));
    assert.match(result.left.message, pattern);
  });

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;
    const before = yield* snapshot(state);
    assert.deepEqual(yield* readPersonalRatingEvents(state, example.profile_id), []);
    yield* rejects(appendPersonalRating(state, { ...example, profile_id: "other" }), /selected state/);
    yield* rejects(appendPersonalRating(state, { ...example, ad_id: "invalid" }), /UUID/);
    yield* rejects(appendPersonalRating(state, { ...example, source: "other" }), /NAV/);
    yield* rejects(appendPersonalRating(state, { ...example, reason: "line\nbreak" }), /text/);
    yield* rejects(appendPersonalRating(state, { ...example, source_version: " " }), /text/);
    yield* rejects(appendPersonalRating(state, { ...example, result_id: 0 }), /result ID/);
    yield* rejects(appendPersonalRating({ ...state, readonly: true }, example), /read-only/);
    yield* rejects(appendPersonalRating(state, example).pipe(Effect.withClock(fixedClock(253_402_300_800_000_000_000n))), /clock/);
    assert.deepEqual(yield* snapshot(state), before);

    yield* rejects(sql.withTransaction(Effect.gen(function* () {
      assert.equal((yield* appendPersonalRating(state, example)).id, "1");
      assert.equal((yield* readPersonalRatingEvents(state, example.profile_id)).length, 1);

      return yield* Effect.fail(new Error("force caller rollback"));
    })), /force caller rollback/);
    assert.deepEqual(yield* snapshot(state), before);

    const first = yield* appendPersonalRating(state, { ...example, reason: " Strong fit ", result_id: 9007199254740993n, input_fingerprint: "synthetic-binding" });
    assert.deepEqual(first, { id: "1", ad_id: example.ad_id, source: "nav", source_version: example.source_version, rating: "good", reason: "Strong fit", created_at: timestamp, result_id: "9007199254740993" });
    const after = yield* snapshot(state);
    const coreNames = new Set(before.objects.map(({ name }) => name));
    const added = after.objects.flatMap(({ name, sql }) => !coreNames.has(name) && sql !== null ? [sql] : []);
    assert.equal(added.length, 8);
    assert.equal(createHash("sha256").update(added.sort().join("\n")).digest("hex"), freshV2Hash);
    assert.deepEqual(after.objects.filter(({ name }) => coreNames.has(name)), before.objects);
    assert.deepEqual(after.userVersion, before.userVersion);
    assert.deepEqual(yield* sql`SELECT * FROM personal_feedback_schema`, [{ profile_id: example.profile_id, schema_version: 2 }]);
    assert.deepEqual(yield* sql`SELECT input_fingerprint FROM personal_ratings`, [{ input_fingerprint: "synthetic-binding" }]);

    yield* sql`UPDATE personal_ratings SET id=9007199254740992`;
    const next = yield* appendPersonalRating(state, { ...example, rating: "very_bad" });
    assert.equal(next.id, "9007199254740993");
    assert.deepEqual(yield* readPersonalRatingEvents(state, example.profile_id), [{ ...first, id: "9007199254740992" }, next]);
    assert.deepEqual(yield* snapshot(state), after);

    yield* sql`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n < 49999)
      INSERT INTO personal_ratings(id, profile_id, source, ad_id, source_version, rating, reason, created_at)
      SELECT n, ${example.profile_id}, 'nav', ${example.ad_id}, 'v1', 'good', '', ${timestamp} FROM ids`;
    yield* rejects(readPersonalRatingEvents(state, example.profile_id), /exceeds the feedback events limit/);
    assert.deepEqual(yield* snapshot(state), after);
  }));

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;

    for (const statement of frozenV1) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO personal_feedback_schema VALUES (${example.profile_id},1)`;
    yield* sql`INSERT INTO personal_ratings(id,profile_id,source,ad_id,source_version,rating,reason,created_at) VALUES
      (2,${example.profile_id},'nav',${example.ad_id},'v1','unsure','','2026-01-02T00:00:00+00:00'),
      (3,${example.profile_id},'nav',${example.ad_id},'v1','bad','','2026-01-01T00:00:00+00:00'),
      (4,'other','nav',${example.ad_id},'v1','very_good','','2026-01-01T00:00:00+00:00')`;
    const before = yield* snapshot(state);
    const rows = yield* sql`SELECT * FROM personal_ratings ORDER BY id`;
    assert.deepEqual((yield* readPersonalRatingEvents(state, example.profile_id)).map(({ id }) => id), ["3", "2"]);
    yield* rejects(appendPersonalRating(state, example), /v1 is read-only/);
    assert.deepEqual(yield* snapshot(state), before);
    assert.deepEqual(yield* sql`SELECT * FROM personal_ratings ORDER BY id`, rows);
    assert.deepEqual(yield* sql`SELECT * FROM personal_feedback_schema`, [{ profile_id: example.profile_id, schema_version: 1 }]);

    // Simulate the frozen migration as a pre-existing file without invoking it in production.
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN preferences_content_fingerprint TEXT`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN job_preferences_version TEXT`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN hard_geography_fingerprint TEXT`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared', 'proposed', 'no_proposal', 'stale'))`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN completed_at TEXT`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN result_fingerprint TEXT`;
    yield* sql`ALTER TABLE calibration_runs ADD COLUMN no_proposal_reason TEXT NOT NULL DEFAULT ''`;
    yield* sql`CREATE UNIQUE INDEX calibration_runs_request_unique ON calibration_runs(profile_id, request_fingerprint)`;
    yield* sql`UPDATE personal_feedback_schema SET schema_version=2`;
    const migrated = yield* snapshot(state);
    const newRow = yield* appendPersonalRating(state, example);
    assert.deepEqual((yield* readPersonalRatingEvents(state, example.profile_id)).map(({ id }) => id), ["3", newRow.id, "2"]);
    assert.deepEqual(yield* snapshot(state), migrated);
  }));

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;
    yield* sql`CREATE VIEW PERSONAL_RATINGS AS SELECT 1`;
    const partial = yield* snapshot(state);
    yield* rejects(readPersonalRatingEvents(state, example.profile_id), /layout/);
    yield* rejects(appendPersonalRating(state, example), /layout/);
    assert.deepEqual(yield* snapshot(state), partial);

    yield* sql`DROP VIEW PERSONAL_RATINGS`;
    yield* sql`UPDATE personal_state_profile SET profile_id='other'`;
    const before = yield* snapshot(state);
    yield* rejects(appendPersonalRating(state, example), /ownership/);
    assert.deepEqual(yield* snapshot(state), before);
    yield* sql`UPDATE personal_state_profile SET profile_id=${example.profile_id}`;

    yield* appendPersonalRating(state, example);
    yield* sql`UPDATE personal_feedback_schema SET schema_version=99`;
    const incompatible = yield* snapshot(state);
    const rows = yield* sql`SELECT * FROM personal_ratings`;
    yield* rejects(readPersonalRatingEvents(state, example.profile_id), /version/);
    yield* rejects(appendPersonalRating(state, example), /version/);
    assert.deepEqual(yield* snapshot(state), incompatible);
    assert.deepEqual(yield* sql`SELECT * FROM personal_ratings`, rows);
    assert.deepEqual(yield* sql`SELECT schema_version FROM personal_feedback_schema`, [{ schema_version: 99 }]);
  }));

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;

    for (const statement of frozenV1) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO personal_feedback_schema VALUES ('other',1)`;
    const before = yield* snapshot(state);
    yield* rejects(readPersonalRatingEvents(state, example.profile_id), /metadata/);
    yield* rejects(appendPersonalRating(state, example), /metadata/);
    assert.deepEqual(yield* snapshot(state), before);
    assert.deepEqual(yield* sql`SELECT * FROM personal_feedback_schema`, [{ profile_id: "other", schema_version: 1 }]);
    assert.deepEqual(yield* sql`SELECT * FROM personal_ratings`, []);
  }));

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;
    yield* sql`CREATE TEMP TABLE personal_ratings(profile_id TEXT, source TEXT, ad_id TEXT, id INTEGER)`;
    yield* sql`CREATE TEMP TABLE unrelated(value TEXT)`;
    yield* sql`INSERT INTO temp.unrelated VALUES ('keep')`;
    const before = yield* snapshot(state);
    yield* rejects(appendPersonalRating(state, example), /Temporary object conflicts/);
    assert.deepEqual(yield* snapshot(state), before);
    assert.deepEqual(yield* readPersonalRatingEvents(state, example.profile_id), []);
    assert.deepEqual(yield* sql`SELECT * FROM temp.personal_ratings`, []);

    yield* sql`DROP TABLE temp.personal_ratings`;
    assert.equal((yield* appendPersonalRating(state, example)).id, "1");
    assert.deepEqual(yield* sql`SELECT * FROM temp.unrelated`, [{ value: "keep" }]);
  }));

  await run((state) => Effect.gen(function* () {
    const sql = state.sql;
    yield* appendPersonalRating(state, example);
    yield* sql`CREATE TEMP TRIGGER rewrite_rating AFTER INSERT ON main.personal_ratings
      BEGIN UPDATE personal_ratings SET reason='changed' WHERE id=NEW.id; END`;
    const before = yield* snapshot(state);
    const metadata = yield* sql`SELECT * FROM main.personal_feedback_schema`;
    const rows = yield* sql`SELECT * FROM main.personal_ratings`;
    yield* rejects(appendPersonalRating(state, example), /Temporary object conflicts/);
    assert.deepEqual(yield* snapshot(state), before);
    assert.deepEqual(yield* sql`SELECT * FROM main.personal_feedback_schema`, metadata);
    assert.deepEqual(yield* sql`SELECT * FROM main.personal_ratings`, rows);
    assert.deepEqual(yield* sql`SELECT name FROM temp.sqlite_schema WHERE type='trigger'`, [{ name: "rewrite_rating" }]);
  }));
};

if (import.meta.main) {
  await runCases();
} else {
  const { expect, test } = await import("vitest");
  test("personal ratings preserve frozen namespaces, exact history, and atomic writes in selected Bun SQLite", () => {
    const result = spawnSync("bun", [fileURLToPath(import.meta.url)], { encoding: "utf8", timeout: 20_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 25_000);
}
