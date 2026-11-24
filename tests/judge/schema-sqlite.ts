import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Either, Schema } from "effect";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSchema, validateReadSchema } from "../../src/lib/server/judge/schema";

const expectedSchema = Schema.decodeUnknownSync(Schema.Struct({ schema_objects: Schema.Array(Schema.Tuple(Schema.String, Schema.String, Schema.String, Schema.NullOr(Schema.String))) }))(JSON.parse(await readFile(new URL("../oracle/resume-run/judge/interrupted-store.json", import.meta.url), "utf8")));

const run = <A, E>(program: Effect.Effect<A, E, SqliteClient.SqliteClient>, filename = ":memory:", readonly = false) =>
  Effect.runPromise(Effect.provide(program, SqliteClient.layer({ filename, readonly, create: !readonly, readwrite: !readonly, disableWAL: true })));

const snapshot = (sql: SqliteClient.SqliteClient) => Effect.gen(function* () {
  return {
    schema: yield* sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`,
    version: yield* sql`PRAGMA user_version`, journal: yield* sql`PRAGMA journal_mode`,
    foreignKeys: yield* sql`PRAGMA foreign_keys`,
  };
});

const rejects = <A>(program: Effect.Effect<A, { readonly message: string }>, message: string) => Effect.gen(function* () {
  const result = yield* Effect.either(program);
  assert(Either.isLeft(result));
  assert.equal(result.left.message, message);
});

await run(Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient;
  assert.equal(yield* validateReadSchema(sql, "invented"), false);
  yield* initializeSchema(sql, "invented");
  assert.equal(yield* validateReadSchema(sql, "invented"), true);
  const objects = yield* sql<{ type: string; name: string; tbl_name: string; sql: string | null }>`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;
  assert.deepEqual(objects.map((row) => [row.type, row.name, row.tbl_name, row.sql]), expectedSchema.schema_objects.map(([type, name, table, sql]) =>
    [type, name, table, name === "review_runs" ? sql?.replace(/\)$/u, ", rereview_scope TEXT)") : sql]));
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
  assert.deepEqual(tables.map((row) => row.name), ["attempt_diagnostics", "attempt_reviewers", "model_call_log", "personal_state_profile", "personal_state_schema", "review_consents", "review_run_candidates", "review_runs", "stage_attempt_candidates", "stage_attempts", "stage_results", "standing_consents"]);
  const names = (table: string) => sql.unsafe<{ name: string; dflt_value: string | null }>(`PRAGMA table_info(${table})`);
  assert.deepEqual((yield* names("stage_attempt_candidates")).map((row) => row.name), ["attempt_id", "listing_id", "source_version", "input_fingerprint", "source_text_fingerprint", "snapshot_provenance_json", "upstream_result_id"]);
  assert.deepEqual((yield* names("stage_attempts")).slice(-2).map((row) => row.name), ["blocked_sub_reason", "submitted_at"]);
  assert.equal((yield* names("review_runs")).find((row) => row.name === "full_review_batch_size")?.dflt_value, "5");
  assert.equal((yield* names("review_runs")).at(-1)?.name, "rereview_scope");
  assert.deepEqual((yield* names("model_call_log")).map((row) => row.name), ["attempt_id", "run_id", "step", "harness", "provider", "model", "effort", "started_at", "input_tokens", "output_tokens", "wall_time_seconds"]);
  const indexes = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name`;
  assert.deepEqual(indexes.map((row) => row.name), ["one_open_personal_review_run", "stage_attempts_lookup", "stage_results_current"]);
  yield* sql`PRAGMA user_version = 37`;
  yield* sql`CREATE TABLE personal_ratings (id TEXT PRIMARY KEY, value TEXT)`;
  yield* sql`INSERT INTO personal_ratings VALUES ('synthetic-rating','retain')`;
  yield* sql`CREATE TABLE personal_feedback_schema (namespace TEXT PRIMARY KEY, version INTEGER)`;
  yield* sql`INSERT INTO personal_feedback_schema VALUES ('feedback',9)`;

  for (const table of ["calibration_runs", "calibration_run_evidence", "calibration_proposals", "calibration_proposal_evidence", "calibration_proposal_events", "historical_review_results", "review_result_contexts"]) {
    yield* sql.unsafe(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, payload TEXT)`);
    yield* sql.unsafe(`INSERT INTO ${table} VALUES ('invented','retained')`);
  }

  yield* sql`INSERT INTO review_runs (run_id,profile_id,coverage_id,source_checked_at,profile_fingerprint,preferences_fingerprint,rules_fingerprint,scoring_version,status,candidate_count,started_at)
    VALUES ('run','invented','coverage','t','profile','prefs','rules','v1','completed',0,'t')`;
  yield* sql`INSERT INTO standing_consents VALUES ('standing','invented','t','person','test','reviewer','hash','text',NULL,NULL,NULL)`;
  yield* sql`INSERT INTO review_consents VALUES ('consent','invented','t','reviewer','h','p','m','e',1,'person','test','hash','text',NULL,'standing')`;

  const before = yield* snapshot(sql);
  const consent = yield* sql`SELECT * FROM review_consents`;
  yield* initializeSchema(sql, "invented");
  assert.deepEqual(yield* snapshot(sql), before);
  assert.deepEqual(yield* sql`SELECT * FROM review_consents`, consent);
  assert.deepEqual(yield* sql`SELECT * FROM personal_ratings`, [{ id: "synthetic-rating", value: "retain" }]);
  assert.deepEqual(yield* sql`SELECT * FROM personal_feedback_schema`, [{ namespace: "feedback", version: 9 }]);
  yield* rejects(initializeSchema(sql, "other"), "Personal state profile mismatch");
  assert.deepEqual(yield* snapshot(sql), before);

  // Synthetic older optional-column layout, not a reconstructed oracle container.
  for (const [table, column] of [["review_runs", "rereview_scope"], ["review_runs", "full_review_batch_size"], ["stage_attempt_candidates", "snapshot_provenance_json"], ["stage_attempts", "blocked_sub_reason"], ["stage_attempts", "submitted_at"], ["standing_consents", "expires_at"], ["review_consents", "standing_consent_id"]]) {
    yield* sql.unsafe(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }

  yield* sql`DROP TABLE model_call_log`;
  assert.equal(yield* validateReadSchema(sql, "invented"), true);
  yield* initializeSchema(sql, "invented");
  assert.deepEqual((yield* names("stage_attempts")).slice(-2).map((row) => row.name), ["blocked_sub_reason", "submitted_at"]);
  assert.equal((yield* names("review_runs")).find((row) => row.name === "full_review_batch_size")?.dflt_value, "5");

  assert.equal((yield* sql<{ expires_at: unknown }>`SELECT expires_at FROM standing_consents`)[0]?.expires_at, null);
  assert.equal((yield* sql<{ standing_consent_id: unknown }>`SELECT standing_consent_id FROM review_consents`)[0]?.standing_consent_id, null);
  assert.equal((yield* sql`SELECT * FROM personal_ratings`).length, 1);
  assert.equal((yield* sql<{ full_review_batch_size: number }>`SELECT full_review_batch_size FROM review_runs`)[0]?.full_review_batch_size, 5);

  for (const table of ["calibration_runs", "calibration_run_evidence", "calibration_proposals", "calibration_proposal_evidence", "calibration_proposal_events", "historical_review_results", "review_result_contexts"]) {
    assert.deepEqual(yield* sql.unsafe(`SELECT * FROM ${table}`), [{ id: "invented", payload: "retained" }]);
  }
}));

for (const [ddl, message] of [
  ["CREATE TABLE foreign_table (id INTEGER)", "Personal state database has unregistered tables"],
  ["CREATE TABLE review_runs (id INTEGER)", "Personal state core schema is incomplete"],
  ["CREATE TABLE reviewed_identities (id INTEGER)", "Legacy review ledger is incomplete"],
] as const) {
  await run(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql.unsafe(ddl);
    const before = yield* snapshot(sql);
    yield* sql`PRAGMA query_only = ON`;
    yield* rejects(validateReadSchema(sql, "invented"), message);
    yield* sql`PRAGMA query_only = OFF`;
    yield* rejects(initializeSchema(sql, "invented"), message);
    assert.deepEqual(yield* snapshot(sql), before);
  }));
}

await run(Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient;
  yield* sql`CREATE TABLE reviewed_identity_metadata (key TEXT, value TEXT)`;
  yield* sql`CREATE TABLE reviewed_identities (id TEXT)`;
  yield* sql`INSERT INTO reviewed_identity_metadata VALUES ('profile_id','other'),('schema_version','1')`;
  const before = yield* snapshot(sql);
  yield* rejects(validateReadSchema(sql, "invented"), "Legacy review ledger profile or schema mismatch");
  yield* rejects(initializeSchema(sql, "invented"), "Legacy review ledger profile or schema mismatch");
  assert.deepEqual(yield* snapshot(sql), before);
  yield* sql`UPDATE reviewed_identity_metadata SET value='invented' WHERE key='profile_id'`;
  yield* sql`INSERT INTO reviewed_identity_metadata VALUES ('unexpected','value')`;
  yield* rejects(validateReadSchema(sql, "invented"), "Legacy review ledger profile or schema mismatch");
  yield* sql`DELETE FROM reviewed_identity_metadata WHERE key='unexpected'`;
  assert.equal(yield* validateReadSchema(sql, "invented"), false);
  yield* initializeSchema(sql, "invented");
  assert.equal((yield* sql`SELECT * FROM reviewed_identity_metadata`).length, 2);
}));

for (const version of [2, -1, "invalid"]) {
  await run(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* initializeSchema(sql, "invented");
    yield* sql`PRAGMA ignore_check_constraints = ON`;
    yield* sql`UPDATE personal_state_schema SET version=${version}`;
    yield* sql`DELETE FROM personal_state_profile`;
    const before = yield* snapshot(sql);
    yield* rejects(initializeSchema(sql, "invented"), "Unsupported personal state schema");
    assert.deepEqual(yield* sql`SELECT * FROM personal_state_profile`, []);
    assert.deepEqual(yield* snapshot(sql), before);
  }));
}

// Namespace zero is supported when core tables do not already exist, exactly as frozen.
await run(Effect.gen(function* () {
  const sql = yield* SqliteClient.SqliteClient;
  yield* sql`CREATE TABLE personal_ratings (id TEXT)`;
  yield* initializeSchema(sql, "invented");
  assert.deepEqual(yield* sql`SELECT * FROM personal_state_schema`, [{ namespace: "core", version: 1 }]);
  // Fail after an additive ALTER to prove DDL rolls back, not just validation.
  yield* sql`ALTER TABLE review_runs DROP COLUMN full_review_batch_size`;
  yield* sql`DROP TABLE standing_consents`;
  yield* sql`CREATE VIEW standing_consents AS SELECT 'collision' AS standing_id`;
  const before = yield* snapshot(sql);
  const result = yield* Effect.either(initializeSchema(sql, "invented"));
  assert(Either.isLeft(result));
  assert.equal(result.left._tag, "JudgeStateError");
  assert.deepEqual(yield* snapshot(sql), before);
}));


const dir = await mkdtemp(join(tmpdir(), "pulse-judge-schema-"));

try {
  const path = join(dir, "synthetic.sqlite");
  await run(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* initializeSchema(sql, "invented");
    yield* sql`PRAGMA user_version = 29`;
  }), path);
  const bytes = await readFile(path);
  const files = await readdir(dir);
  await run(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    const before = yield* snapshot(sql);
    assert.equal(yield* validateReadSchema(sql, "invented"), true);
    yield* rejects(validateReadSchema(sql, "other"), "Personal state profile mismatch");
    assert.deepEqual(yield* snapshot(sql), before);
  }), path, true);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(dir), files);

  for (const version of [0, 2]) {
    await run(Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`UPDATE personal_state_schema SET version=${version}`;
    }), path);
    const before = await readFile(path);
    await run(Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* rejects(validateReadSchema(sql, "invented"), "Unsupported personal state schema");
    }), path, true);
    assert.deepEqual(await readFile(path), before);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

