import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";
import { readCurrentAd, readManifest } from "../../src/lib/server/source/readers.ts";
import { acquireStore, type SourceSql } from "../../src/lib/server/source/store.ts";
import { captureSourceDatabase } from "../oracle/source-database.ts";

const metadata = (sql: SourceSql) => Effect.gen(function* () {
  return {
    schema: yield* sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`,
    schemaVersion: yield* sql`PRAGMA schema_version`, version: yield* sql`PRAGMA user_version`,
    journal: yield* sql`PRAGMA journal_mode`,
  };
});

const program = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cell = Schema.Union(Schema.String, Schema.Number, Schema.Null);
  const dumpSchema = Schema.parseJson(Schema.Struct({ user_version: Schema.Int, schema_objects: Schema.Array(Schema.Tuple(Schema.String, Schema.String, Schema.String, Schema.NullOr(Schema.String))), tables: Schema.Record({ key: Schema.String, value: Schema.Struct({ columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(cell)) }) }) }));
  const recordedDump = yield* fs.readFileString("tests/oracle/basic-run/source/run-1.json");
  const dump = yield* Schema.decodeUnknown(dumpSchema)(recordedDump);

  // Always test exact original container bytes; no ignored-file dependency or skip.
  const encoded = yield* fs.readFileString("tests/fixtures/source/original-python-source.sqlite3.gz.base64");
  const original = gunzipSync(Buffer.from(encoded, "base64"));
  assert.equal(original.byteLength, 139264);
  assert.equal(sha256(original), "cb31cb6f2474225712943530d1a0f222160924468b189fe2c7211f7bb13ad820");

  for (const variant of ["original-python", "dump-reconstruction"] as const) {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-oracle-reader-" });
    const path = join(directory, "source.sqlite3");
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

    if (variant === "original-python") yield* fs.writeFile(path, original);
    else yield* Effect.scoped(Effect.gen(function* () {
      const sql = yield* acquireStore(path, "create");

      yield* sql.withTransaction(Effect.gen(function* () {
        for (const [type, , , statement] of dump.schema_objects) if (type === "table" && statement) yield* sql.unsafe(statement);

        for (const [name, table] of Object.entries(dump.tables)) {
          for (const row of table.rows) yield* sql.unsafe(`INSERT INTO ${quote(name)} (${table.columns.map(quote).join(",")}) VALUES (${row.map(() => "?").join(",")})`, row);
        }

        for (const [type, , , statement] of dump.schema_objects) if (type !== "table" && statement) yield* sql.unsafe(statement);
        yield* sql.unsafe(`PRAGMA user_version=${dump.user_version}`);
      }));
    }));
    const before = yield* fs.readFile(path);

    const beforeInfo = yield* Effect.scoped(Effect.gen(function* () {
      const sql = yield* acquireStore(path, "readonly");

      if (variant === "original-python") assert.equal(yield* captureSourceDatabase(sql), recordedDump);

      return yield* metadata(sql);
    }));

    const manifest = yield* readManifest(path, 1000, "2026-10-19T12:00:00+00:00");
    assert.equal(manifest.listing_count, dump.tables.ads!.rows.length);
    const id = yield* Schema.decodeUnknown(Schema.String)(dump.tables.ads!.rows[0]![dump.tables.ads!.columns.indexOf("uuid")]);
    yield* Effect.scoped(Effect.gen(function* () {
      const sql = yield* acquireStore(path, "readonly");
      const current = yield* readCurrentAd(sql, id, true);
      assert.equal(current.ad?.uuid, id);
      assert.equal(current.version_changed, current.ad?.changed);
      assert.deepEqual(yield* metadata(sql), beforeInfo);
    }));
    assert.deepEqual(yield* fs.readFile(path), before);
    assert.deepEqual(yield* fs.readDirectory(directory), ["source.sqlite3"]);
  }
}));

export const checkOracleCopy = () => Effect.runPromise(program.pipe(Effect.provide(BunContext.layer)));
