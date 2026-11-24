import { Effect } from "effect";
import { hasTable, type SourceSql } from "./store.ts";
import { SourceError } from "./errors.ts";
import { isRollingDeadline } from "./core.ts";

// Exact frozen SQL, copied as data. Acquisition/reads do not migrate; selected writers call upgrades.
const sourceStatements = [
  "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS pages (\n            url TEXT PRIMARY KEY, etag TEXT, modified TEXT\n        );",
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY);",
  "CREATE TABLE IF NOT EXISTS versions (uuid TEXT PRIMARY KEY, changed TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS ad_application_deadlines (\n            uuid TEXT PRIMARY KEY, changed TEXT NOT NULL, application_due TEXT,\n            rolling INTEGER NOT NULL DEFAULT 0\n        );",
  "CREATE TABLE IF NOT EXISTS ad_status_evidence (\n            uuid TEXT PRIMARY KEY, changed TEXT NOT NULL, status TEXT NOT NULL\n                CHECK(status IN ('ACTIVE','INACTIVE','STOPPED','DELETED'))\n        );",
  "CREATE TABLE IF NOT EXISTS ad_detail_versions (\n            uuid TEXT PRIMARY KEY, saved_changed TEXT NOT NULL,\n            detail_changed TEXT NOT NULL\n        );",
  "CREATE TABLE IF NOT EXISTS ads (\n            uuid TEXT PRIMARY KEY, changed TEXT NOT NULL,\n            first_seen TEXT NOT NULL, observed TEXT NOT NULL,\n            title TEXT NOT NULL, employer TEXT NOT NULL, locations TEXT NOT NULL,\n            topics TEXT NOT NULL, detail_missing INTEGER NOT NULL,\n            expires TEXT, source TEXT\n        );",
  "CREATE TABLE IF NOT EXISTS ad_occupations (\n            uuid TEXT NOT NULL, scheme TEXT NOT NULL,\n            level1 TEXT NOT NULL, level2 TEXT NOT NULL,\n            code TEXT NOT NULL, name TEXT NOT NULL,\n            PRIMARY KEY (uuid, scheme, level1, level2, code, name)\n        );",
  "CREATE TABLE IF NOT EXISTS ad_occupation_checks (\n            uuid TEXT PRIMARY KEY, saved_changed TEXT NOT NULL,\n            category_count INTEGER NOT NULL\n        );",
  "CREATE TABLE IF NOT EXISTS ad_texts (\n            uuid TEXT PRIMARY KEY, text TEXT NOT NULL, detail_changed TEXT NOT NULL,\n            closed_at TEXT\n        );",
  "CREATE TRIGGER IF NOT EXISTS ads_detail_version_cleanup\n        AFTER DELETE ON ads\n        BEGIN\n            DELETE FROM ad_detail_versions WHERE uuid = OLD.uuid;\n        END;",
  "CREATE TRIGGER ads_text_cleanup\n        AFTER DELETE ON ads\n        BEGIN\n            DELETE FROM ad_texts WHERE uuid = OLD.uuid AND closed_at IS NULL;\n        END;",
  "CREATE TRIGGER IF NOT EXISTS ads_occupation_cleanup\n        AFTER DELETE ON ads\n        BEGIN\n            DELETE FROM ad_occupations WHERE uuid = OLD.uuid;\n            DELETE FROM ad_occupation_checks WHERE uuid = OLD.uuid;\n        END;",
  "CREATE TABLE ad_salaries (\n        uuid TEXT PRIMARY KEY, form TEXT\n            CHECK(form IS NULL OR form IN ('range','single','vague','max')),\n        min_nok REAL, max_nok REAL,\n        period TEXT CHECK(period IS NULL OR period IN ('year','month','hour')),\n        sko_code TEXT, ltr_min INTEGER, ltr_max INTEGER,\n        detail_changed TEXT NOT NULL,\n        period_inferred INTEGER NOT NULL DEFAULT 0,\n        amount_unclear INTEGER NOT NULL DEFAULT 0\n    )"
];

const locationStatements = [
  "CREATE TABLE IF NOT EXISTS ad_locations (\n        uuid TEXT PRIMARY KEY, points TEXT NOT NULL, incomplete INTEGER NOT NULL,\n        provenance TEXT NOT NULL\n    )",
  "CREATE TRIGGER IF NOT EXISTS ads_location_cleanup\n        AFTER DELETE ON ads\n        BEGIN DELETE FROM ad_locations WHERE uuid=OLD.uuid; END"
];

const salaryStatement = sourceStatements.at(-1)!;
const salaryColumns = "uuid, form, min_nok, max_nok, period, sko_code, ltr_min, ltr_max, detail_changed, period_inferred, amount_unclear";

// Explicit writer-only migration. Reads and acquisition never call it.
export const upgradeSourceStorage = (sql: SourceSql) => Effect.gen(function* () {
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`;
  const known = new Set(["state", "pages", "events", "versions", "ad_application_deadlines", "ad_status_evidence", "ad_detail_versions", "ads", "ad_occupations", "ad_occupation_checks", "ad_texts", "ad_salaries", "ad_locations"]);
  const adColumns = (yield* sql<{ name: string }>`PRAGMA table_info(ads)`).map((column) => column.name);

  if (tables.some((table) => !table.name.startsWith("sqlite_") && !known.has(table.name)) || adColumns.join(",") !== "uuid,changed,first_seen,observed,title,employer,locations,topics,detail_missing,expires,source") return yield* new SourceError({ message: "Unrecognized Source database" });

  yield* sql.withTransaction(Effect.gen(function* () {
    const cleanup = (yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='ads_text_cleanup'`)[0];
    const cleanupStatement = sourceStatements[12]!;

    for (const statement of sourceStatements.slice(0, -1)) {
      if (statement === cleanupStatement) {
        if (cleanup?.sql === statement.replace(/;\s*$/u, "")) continue;

        yield* sql`DROP TRIGGER IF EXISTS ads_text_cleanup`;
      }

      yield* sql.unsafe(statement);
    }

    const textColumns = yield* sql<{ name: string }>`PRAGMA table_info(ad_texts)`;

    if (!textColumns.some((column) => column.name === "closed_at")) yield* sql`ALTER TABLE ad_texts ADD COLUMN closed_at TEXT`;
    const salary = (yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type='table' AND name='ad_salaries'`)[0];

    if (!salary) yield* sql.unsafe(salaryStatement);
    else {
      const columns = new Set((yield* sql<{ name: string }>`PRAGMA table_info(ad_salaries)`).map((column) => column.name));

      if (!salary.sql.includes("'max'")) {
        yield* sql.unsafe(salaryStatement.replace("CREATE TABLE ad_salaries", "CREATE TABLE ad_salaries_rebuilt"));
        const selected = ["period_inferred", "amount_unclear"].map((name) => columns.has(name) ? `COALESCE(${name}, 0)` : "0").join(", ");
        yield* sql.unsafe(`INSERT INTO ad_salaries_rebuilt (${salaryColumns}) SELECT uuid, form, min_nok, max_nok, period, sko_code, ltr_min, ltr_max, detail_changed, ${selected} FROM ad_salaries`);
        yield* sql`DROP TABLE ad_salaries`;
        yield* sql`ALTER TABLE ad_salaries_rebuilt RENAME TO ad_salaries`;
      } else {
        if (!columns.has("period_inferred")) yield* sql`ALTER TABLE ad_salaries ADD COLUMN period_inferred INTEGER NOT NULL DEFAULT 0`;

        if (!columns.has("amount_unclear")) yield* sql`ALTER TABLE ad_salaries ADD COLUMN amount_unclear INTEGER NOT NULL DEFAULT 0`;
      }
    }

    const deadlines = yield* sql<{ name: string }>`PRAGMA table_info(ad_application_deadlines)`;

    if (!deadlines.some((column) => column.name === "rolling")) yield* sql`ALTER TABLE ad_application_deadlines ADD COLUMN rolling INTEGER NOT NULL DEFAULT 0`;
    const rows = yield* sql<{ uuid: string; application_due: string }>`SELECT uuid,application_due FROM ad_application_deadlines WHERE rolling=0 AND application_due IS NOT NULL`;

    for (const row of rows) {
      if (isRollingDeadline(row.application_due)) yield* sql`UPDATE ad_application_deadlines SET rolling=1,application_due=NULL WHERE uuid=${row.uuid}`;
    }

    yield* initializeLocationStorage(sql);
  }));
});

export const initializeLocationStorage = (sql: SourceSql) => Effect.gen(function* () {
  if (!(yield* hasTable(sql, "ads"))) return yield* new SourceError({ message: "Existing source ads table required" });

  for (const statement of locationStatements) yield* sql.unsafe(statement);
});

// Caller must select a newly owned empty store. This is not an upgrade path.
export const initializeSourceStorage = (sql: SourceSql) => Effect.gen(function* () {
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`;

  if (tables.length) return yield* new SourceError({ message: "Source initialization requires an empty store" });

  for (const statement of sourceStatements) yield* sql.unsafe(statement);

  yield* initializeLocationStorage(sql);
});
