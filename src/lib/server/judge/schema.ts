import type { SqlClient } from "@effect/sql/SqlClient";
import { Effect, Predicate } from "effect";
import { JudgeStateError } from "./errors";

const coreTables = [
  "personal_state_profile", "personal_state_schema", "review_runs",
  "review_run_candidates", "stage_attempts", "stage_attempt_candidates", "stage_results",
];

const registeredTables = new Set([
  ...coreTables, "reviewed_identity_metadata", "reviewed_identities",
  "personal_ratings", "calibration_runs", "calibration_run_evidence",
  "calibration_proposals", "calibration_proposal_evidence", "calibration_proposal_events",
  "personal_feedback_schema", "historical_review_results", "review_result_contexts",
  "attempt_diagnostics", "standing_consents", "review_consents", "attempt_reviewers", "model_call_log",
]);

const fail = (message: string) => Effect.fail(new JudgeStateError({ message }));
const sqlError = (cause: unknown) => new JudgeStateError({ message: "Personal state schema operation failed", cause });

const validateTableNames = (sql: SqlClient) => Effect.gen(function* () {
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`;

  const tables = new Set(rows.map((row) => row.name).filter((name) => !name.startsWith("sqlite_")));

  if ([...tables].some((name) => !registeredTables.has(name))) {
    return yield* fail("Personal state database has unregistered tables");
  }

  return tables;
});

const validateTables = (sql: SqlClient, profileId: string) => Effect.gen(function* () {
  const tables = yield* validateTableNames(sql);
  const legacyCount = Number(tables.has("reviewed_identity_metadata")) + Number(tables.has("reviewed_identities"));

  if (legacyCount === 1) return yield* fail("Legacy review ledger is incomplete");

  if (legacyCount === 2) {
    const metadata = new Map((yield* sql<{ key: string; value: string }>`SELECT key,value FROM reviewed_identity_metadata`).map((row) => [row.key, row.value]));

    if (metadata.size !== 2 || metadata.get("profile_id") !== profileId || metadata.get("schema_version") !== "1") {
      return yield* fail("Legacy review ledger profile or schema mismatch");
    }
  }

  const count = coreTables.filter((name) => tables.has(name)).length;

  if (count !== 0 && count !== coreTables.length) return yield* fail("Personal state core schema is incomplete");

  return count !== 0;
});

/** Read-only inspection never initializes an absent core namespace. */
export const validateReadSchema = (sql: SqlClient, profileId: string): Effect.Effect<boolean, JudgeStateError> =>
  Effect.gen(function* () {
    if (!(yield* validateTables(sql, profileId))) return false;

    const profile = yield* sql<{ profile_id: unknown }>`SELECT profile_id FROM personal_state_profile WHERE singleton=1`;

    if (profile[0]?.profile_id !== profileId) return yield* fail("Personal state profile mismatch");

    const schema = yield* sql<{ version: unknown; storage_type: string }>`SELECT version,typeof(version) AS storage_type FROM personal_state_schema WHERE namespace='core'`;

    if (schema[0]?.storage_type !== "integer" || schema[0]?.version !== 1) return yield* fail("Unsupported personal state schema");

    return true;
  }).pipe(Effect.mapError((error) => Predicate.isTagged(error, "JudgeStateError") ? error : sqlError(error)));

// sqlite_master retains these literal strings. Keep frozen whitespace as well as
// the column order, constraints and indexes; golden schema comparisons are exact.
const coreDDL = [
  `CREATE TABLE review_runs (
                run_id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES personal_state_profile(profile_id),
                coverage_id TEXT NOT NULL,
                source_checked_at TEXT NOT NULL,
                profile_fingerprint TEXT NOT NULL,
                preferences_fingerprint TEXT NOT NULL,
                rules_fingerprint TEXT NOT NULL,
                scoring_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN
                    ('pending','running','partial','completed','failed','blocked','stale','superseded')),
                candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 10000),
                started_at TEXT NOT NULL,
                completed_at TEXT
            )`,
  `CREATE TABLE review_run_candidates (
                run_id TEXT NOT NULL REFERENCES review_runs(run_id),
                listing_id TEXT NOT NULL,
                source_version TEXT NOT NULL,
                candidate_fingerprint TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN
                    ('pending','screened','screened_out','completed')),
                screening_result_id TEXT,
                full_result_id TEXT,
                PRIMARY KEY(run_id,listing_id)
            )`,
  `CREATE TABLE stage_attempts (
                attempt_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES review_runs(run_id),
                profile_id TEXT NOT NULL REFERENCES personal_state_profile(profile_id),
                stage TEXT NOT NULL CHECK(stage IN ('title_screen','full_review')),
                status TEXT NOT NULL CHECK(status IN
                    ('pending','running','completed','failed','blocked','unknown')),
                input_fingerprint TEXT NOT NULL,
                manifest_id TEXT NOT NULL,
                stage_version TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
                retry_of_attempt_id TEXT REFERENCES stage_attempts(attempt_id),
                requested_at TEXT NOT NULL,
                completed_at TEXT,
                error_code TEXT,
                provider_label TEXT,
                model_label TEXT,
                reasoning_level TEXT,
                call_count INTEGER NOT NULL DEFAULT 0 CHECK(call_count >= 0),
                request_bytes INTEGER CHECK(request_bytes >= 0),
                response_bytes INTEGER CHECK(response_bytes >= 0),
                input_tokens INTEGER CHECK(input_tokens >= 0),
                output_tokens INTEGER CHECK(output_tokens >= 0),
                response_fingerprint TEXT,
                UNIQUE(run_id,stage,input_fingerprint,attempt_number)
            )`,
  `CREATE TABLE stage_attempt_candidates (
                attempt_id TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
                listing_id TEXT NOT NULL,
                source_version TEXT NOT NULL,
                input_fingerprint TEXT NOT NULL,
                source_text_fingerprint TEXT,
                snapshot_provenance_json TEXT,
                upstream_result_id TEXT,
                PRIMARY KEY(attempt_id,listing_id)
            )`,
  `CREATE TABLE stage_results (
                result_id TEXT PRIMARY KEY,
                attempt_id TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
                listing_id TEXT NOT NULL,
                stage TEXT NOT NULL CHECK(stage IN ('title_screen','full_review')),
                source_version TEXT NOT NULL,
                input_fingerprint TEXT NOT NULL,
                result_fingerprint TEXT NOT NULL,
                stage_version TEXT NOT NULL,
                prompt_version TEXT NOT NULL,
                profile_fingerprint TEXT NOT NULL,
                preferences_fingerprint TEXT NOT NULL,
                rules_fingerprint TEXT NOT NULL,
                scoring_version TEXT NOT NULL,
                result_json TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                supersedes_result_id TEXT REFERENCES stage_results(result_id),
                upstream_result_id TEXT,
                UNIQUE(attempt_id,listing_id)
            )`,
  `CREATE INDEX stage_results_current
            ON stage_results(listing_id,stage,input_fingerprint,recorded_at)`,
  `CREATE UNIQUE INDEX one_open_personal_review_run
            ON review_runs(profile_id)
            WHERE status IN ('pending','running','partial')`,
  `CREATE INDEX stage_attempts_lookup
            ON stage_attempts(run_id,stage,input_fingerprint,attempt_number)`,
];

const addColumn = (sql: SqlClient, table: string, name: string, definition: string) => Effect.gen(function* () {
  const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);

  if (!columns.some((column) => column.name === name)) yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
});

/** Only an explicitly selected writer may run these frozen transactional upgrades. */
export const initializeSchema = (sql: SqlClient, profileId: string): Effect.Effect<void, JudgeStateError> =>
  sql.withTransaction(Effect.gen(function* () {
    yield* validateTables(sql, profileId);
    yield* sql`CREATE TABLE IF NOT EXISTS personal_state_profile (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    profile_id TEXT NOT NULL UNIQUE
                )`;
    yield* sql`CREATE TABLE IF NOT EXISTS personal_state_schema (
                    namespace TEXT PRIMARY KEY,
                    version INTEGER NOT NULL CHECK(version >= 0)
                )`;
    const profile = yield* sql<{ profile_id: unknown }>`SELECT profile_id FROM personal_state_profile WHERE singleton=1`;

    if (profile.length === 0) yield* sql`INSERT INTO personal_state_profile(singleton,profile_id) VALUES (1,${profileId})`;
    else if (profile[0]?.profile_id !== profileId) return yield* fail("Personal state profile mismatch");
    const schema = yield* sql<{ version: unknown; storage_type: string }>`SELECT version,typeof(version) AS storage_type FROM personal_state_schema WHERE namespace='core'`;
    const version = schema.length === 0 ? 0 : schema[0]?.version;

    if ((schema.length !== 0 && schema[0]?.storage_type !== "integer") || (version !== 0 && version !== 1)) {
      return yield* fail("Unsupported personal state schema");
    }

    if (version === 0) {
      for (const ddl of coreDDL) yield* sql.unsafe(ddl);
      yield* sql`INSERT INTO personal_state_schema(namespace,version) VALUES ('core',1)
        ON CONFLICT(namespace) DO UPDATE SET version=excluded.version`;
    }

    yield* addColumn(sql, "review_runs", "full_review_batch_size", "INTEGER NOT NULL DEFAULT 5 CHECK(full_review_batch_size BETWEEN 1 AND 10)");
    yield* addColumn(sql, "review_runs", "rereview_scope", "TEXT");
    yield* addColumn(sql, "stage_attempt_candidates", "snapshot_provenance_json", "TEXT");
    yield* addColumn(sql, "stage_attempts", "blocked_sub_reason", "TEXT");
    yield* addColumn(sql, "stage_attempts", "submitted_at", "TEXT");
    yield* sql`CREATE TABLE IF NOT EXISTS attempt_diagnostics (
                    attempt_id TEXT PRIMARY KEY REFERENCES stage_attempts(attempt_id),
                    payload_json TEXT NOT NULL
                )`;
    yield* sql`CREATE TABLE IF NOT EXISTS standing_consents (
                    standing_id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL
                        REFERENCES personal_state_profile(profile_id),
                    recorded_at TEXT NOT NULL,
                    consenter TEXT NOT NULL,
                    method TEXT NOT NULL,
                    reviewer_id TEXT NOT NULL,
                    disclosure_sha256 TEXT NOT NULL,
                    disclosure_text TEXT NOT NULL,
                    revoked_at TEXT,
                    revoked_by TEXT,
                    expires_at TEXT
                )`;
    yield* addColumn(sql, "standing_consents", "expires_at", "TEXT");
    yield* sql`CREATE TABLE IF NOT EXISTS review_consents (
                    consent_id TEXT PRIMARY KEY,
                    profile_id TEXT NOT NULL
                        REFERENCES personal_state_profile(profile_id),
                    recorded_at TEXT NOT NULL,
                    reviewer_id TEXT NOT NULL,
                    harness_label TEXT NOT NULL,
                    provider_label TEXT NOT NULL,
                    model_label TEXT NOT NULL,
                    reasoning_level TEXT NOT NULL,
                    max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens > 0),
                    consenter TEXT NOT NULL,
                    method TEXT NOT NULL,
                    disclosure_sha256 TEXT NOT NULL,
                    disclosure_text TEXT NOT NULL,
                    run_id TEXT REFERENCES review_runs(run_id),
                    standing_consent_id TEXT REFERENCES standing_consents(standing_id)
                )`;
    yield* addColumn(sql, "review_consents", "standing_consent_id", "TEXT REFERENCES standing_consents(standing_id)");
    yield* sql`CREATE TABLE IF NOT EXISTS attempt_reviewers (
                    attempt_id TEXT PRIMARY KEY REFERENCES stage_attempts(attempt_id),
                    consent_id TEXT NOT NULL REFERENCES review_consents(consent_id),
                    harness_label TEXT NOT NULL
                )`;
    yield* sql`CREATE TABLE IF NOT EXISTS model_call_log (
                    attempt_id TEXT PRIMARY KEY REFERENCES stage_attempts(attempt_id),
                    run_id TEXT NOT NULL REFERENCES review_runs(run_id),
                    step TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    effort TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    wall_time_seconds REAL
                )`;
    yield* validateTableNames(sql);
  })).pipe(Effect.mapError((error) => Predicate.isTagged(error, "JudgeStateError") ? error : sqlError(error)));
