import { Data, Effect } from "effect";
import type { SqliteResource } from "../shared/sqlite-resource.ts";

export class PersonalRatingError extends Data.TaggedError("PersonalRatingError")<{
  readonly message: string;
}> {}

export const ratingError = (message: string) => new PersonalRatingError({ message });

// Frozen personal_feedback.py _SCHEMA_DDL. Only the rating writer creates it.
const freshV2 = [
  `CREATE TABLE personal_feedback_schema (
        profile_id TEXT PRIMARY KEY
            REFERENCES personal_state_profile(profile_id),
        schema_version INTEGER NOT NULL CHECK(schema_version > 0)
    )`,
  `CREATE TABLE personal_ratings (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES personal_feedback_schema(profile_id),
        source TEXT NOT NULL CHECK(source = 'nav'),
        ad_id TEXT NOT NULL,
        source_version TEXT NOT NULL,
        rating TEXT NOT NULL CHECK(rating IN
            ('very_good', 'good', 'unsure', 'bad', 'very_bad')),
        reason TEXT NOT NULL,
        result_id TEXT,
        input_fingerprint TEXT,
        profile_fingerprint TEXT,
        preferences_fingerprint TEXT,
        rules_fingerprint TEXT,
        scoring_version TEXT,
        review_prompt_version TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(profile_id, id)
    )`,
  `CREATE INDEX personal_ratings_latest
       ON personal_ratings(profile_id, source, ad_id, id DESC)`,
  `CREATE TABLE calibration_runs (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES personal_feedback_schema(profile_id),
        created_at TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        profile_fingerprint TEXT NOT NULL,
        preferences_fingerprint TEXT NOT NULL,
        preferences_content_fingerprint TEXT NOT NULL,
        job_preferences_version TEXT NOT NULL,
        hard_geography_fingerprint TEXT NOT NULL,
        rules_fingerprint TEXT NOT NULL,
        scoring_version TEXT NOT NULL,
        review_prompt_version TEXT NOT NULL,
        calibration_prompt_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN
            ('prepared', 'proposed', 'no_proposal', 'stale')),
        completed_at TEXT,
        result_fingerprint TEXT,
        no_proposal_reason TEXT NOT NULL DEFAULT '',
        UNIQUE(profile_id, id),
        UNIQUE(profile_id, request_fingerprint)
    )`,
  `CREATE TABLE calibration_run_evidence (
        profile_id TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        rating_id INTEGER NOT NULL,
        result_id TEXT,
        source_version TEXT NOT NULL,
        input_fingerprint TEXT,
        PRIMARY KEY(profile_id, run_id, rating_id),
        FOREIGN KEY(profile_id, run_id)
            REFERENCES calibration_runs(profile_id, id),
        FOREIGN KEY(profile_id, rating_id)
            REFERENCES personal_ratings(profile_id, id)
    )`,
  `CREATE TABLE calibration_proposals (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        target TEXT NOT NULL CHECK(target IN ('preferences', 'review_prompt')),
        base_target_version TEXT NOT NULL,
        proposed_target_version TEXT NOT NULL,
        proposed_text TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        rationale TEXT NOT NULL,
        uncertainty TEXT NOT NULL,
        regression_notes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(profile_id, id),
        FOREIGN KEY(profile_id, run_id)
            REFERENCES calibration_runs(profile_id, id)
    )`,
  `CREATE TABLE calibration_proposal_evidence (
        profile_id TEXT NOT NULL,
        proposal_id INTEGER NOT NULL,
        rating_id INTEGER NOT NULL,
        PRIMARY KEY(profile_id, proposal_id, rating_id),
        FOREIGN KEY(profile_id, proposal_id)
            REFERENCES calibration_proposals(profile_id, id),
        FOREIGN KEY(profile_id, rating_id)
            REFERENCES personal_ratings(profile_id, id)
    )`,
  `CREATE TABLE calibration_proposal_events (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        proposal_id INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN
            ('proposed', 'approved', 'rejected', 'applied', 'stale')),
        created_at TEXT NOT NULL,
        owner_confirmed INTEGER NOT NULL CHECK(owner_confirmed IN (0, 1)),
        resulting_version TEXT,
        note TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(profile_id, proposal_id)
            REFERENCES calibration_proposals(profile_id, id)
    )`,
] as const;

// The last frozen v1 DDL and its ALTER-produced v2 retain the older FK layout.
const v1Runs = `CREATE TABLE calibration_runs (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        profile_fingerprint TEXT NOT NULL,
        preferences_fingerprint TEXT NOT NULL,
        rules_fingerprint TEXT NOT NULL,
        scoring_version TEXT NOT NULL,
        review_prompt_version TEXT NOT NULL,
        calibration_prompt_version TEXT NOT NULL,
        UNIQUE(profile_id, id)
    )`;

const v1 = [
  freshV2[0].replace(/\s+REFERENCES personal_state_profile\(profile_id\)/, ""),
  freshV2[1].replace(" REFERENCES personal_feedback_schema(profile_id)", ""),
  freshV2[2], v1Runs, ...freshV2.slice(4),
];

const migratedV2 = [
  ...v1.slice(0, 3),
  v1Runs.replace("UNIQUE(profile_id, id)", `preferences_content_fingerprint TEXT,
    job_preferences_version TEXT, hard_geography_fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared', 'proposed', 'no_proposal', 'stale')),
    completed_at TEXT, result_fingerprint TEXT, no_proposal_reason TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, id)`),
  ...v1.slice(4),
  `CREATE UNIQUE INDEX calibration_runs_request_unique ON calibration_runs(profile_id, request_fingerprint)`,
];

// Ignore formatting between SQL tokens, but preserve literal and token contents.
const sqlTokens = (sql: string) => sql.match(/'(?:''|[^'])*'|[a-zA-Z_][a-zA-Z_0-9]*|[^\s]/g)?.join(" ");

const matchesLayout = (actual: ReadonlySet<string | undefined>, expected: ReadonlyArray<string>) =>
  actual.size === expected.length && expected.every((sql) => actual.has(sqlTokens(sql)));

export const personalRatingSchema = (sql: SqliteResource, profileId: string) => Effect.gen(function* () {
  // Include objects attached to namespace tables (e.g. unexpected triggers),
  // as well as reserved names that might shadow a table or index.
  const objects = yield* sql<{ ddl: string | null }>`SELECT sql AS ddl FROM main.sqlite_schema
    WHERE (lower(name) GLOB 'personal_feedback_*' OR lower(name) GLOB 'personal_rating*' OR lower(name) GLOB 'calibration_*'
        OR lower(tbl_name) GLOB 'personal_feedback_*' OR lower(tbl_name) GLOB 'personal_rating*' OR lower(tbl_name) GLOB 'calibration_*')
      AND name NOT GLOB 'sqlite_autoindex_*' LIMIT 10`;

  if (objects.length === 0) return null;

  const layout = new Set(objects.map(({ ddl }) => ddl === null ? undefined : sqlTokens(ddl)));

  const expectedVersion = matchesLayout(layout, v1) ? 1
    : matchesLayout(layout, freshV2) || matchesLayout(layout, migratedV2) ? 2 : null;

  if (expectedVersion === null || objects.length !== layout.size) {
    return yield* ratingError("Incomplete or unsupported personal feedback layout");
  }

  const rows = yield* sql<{ profile_id: string | null; version: string; storage: string }>`SELECT profile_id,
    CAST(schema_version AS TEXT) AS version, typeof(schema_version) AS storage FROM main.personal_feedback_schema LIMIT 2`;

  if (rows.length !== 1 || rows[0]?.profile_id !== profileId) {
    return yield* ratingError("Personal feedback metadata does not match the selected profile");
  }

  if (rows[0].storage !== "integer" || rows[0].version !== String(expectedVersion)) {
    return yield* ratingError("Unsupported personal feedback schema version");
  }

  return expectedVersion;
});

export const refuseTempRatingConflicts = (sql: SqliteResource) => Effect.gen(function* () {
  const conflicts = yield* sql`SELECT 1 FROM temp.sqlite_schema
    WHERE lower(name) GLOB 'personal_feedback_*' OR lower(name) GLOB 'personal_rating*' OR lower(name) GLOB 'calibration_*'
      OR (type = 'trigger' AND (lower(tbl_name) GLOB 'personal_feedback_*'
        OR lower(tbl_name) GLOB 'personal_rating*' OR lower(tbl_name) GLOB 'calibration_*'))
    LIMIT 1`;

  if (conflicts.length !== 0) return yield* ratingError("Temporary object conflicts with personal feedback namespace");
});

export const createPersonalRatingSchema = (sql: SqliteResource, profileId: string) => Effect.gen(function* () {
  // SQLite binds an index to the schema of its index name, and omits the
  // qualifiers from stored DDL. The frozen table references stay unqualified.
  for (const statement of freshV2) yield* sql.unsafe(statement.replace(/^CREATE (TABLE|INDEX) /, "$&main."));
  yield* sql`INSERT INTO main.personal_feedback_schema(profile_id, schema_version) VALUES (${profileId}, 2)`;
});
