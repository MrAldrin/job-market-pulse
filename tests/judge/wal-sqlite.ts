import { BunContext } from "@effect/platform-bun";
import { Effect } from "effect";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";

const directory = await mkdtemp(join(tmpdir(), "pulse-judge-wal-"));
const path = join(directory, "review.sqlite3");
const selection = { profile_id: "invented", directory, path, readonly: false, require_existing: false };

try {
  const evidence = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const writer = yield* openJudgeDatabase(selection);
    yield* writer.sql`PRAGMA user_version=17`;
    yield* writer.sql`PRAGMA journal_mode=WAL`;
    yield* writer.sql`PRAGMA wal_autocheckpoint=0`;
    const beforeMarker = yield* Effect.promise(() => readFile(path));
    yield* writer.sql.withTransaction(writer.sql`INSERT INTO personal_state_schema VALUES ('uncheckpointed',123)`);
    const beforeReader = yield* Effect.promise(() => readFile(path));
    assert.deepEqual(beforeReader, beforeMarker);
    const wal = yield* Effect.promise(() => readFile(path + "-wal"));
    assert(wal.byteLength > 32);
    const filesBefore = yield* Effect.promise(() => readdir(directory));
    const schemaBefore = yield* writer.sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;
    const sqlite = yield* writer.sql`SELECT sqlite_version() AS version`;

    const filesDuring = yield* Effect.scoped(Effect.gen(function* () {
      const reader = yield* openJudgeDatabase({ ...selection, readonly: true });
      assert.deepEqual(yield* reader.sql`SELECT version FROM personal_state_schema WHERE namespace='uncheckpointed'`, [{ version: 123 }]);
      assert.deepEqual(yield* reader.sql`PRAGMA user_version`, [{ user_version: 17 }]);
      assert.deepEqual(yield* reader.sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
      assert.deepEqual(yield* reader.sql`PRAGMA query_only`, [{ query_only: 1 }]);
      assert.deepEqual(yield* reader.sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      assert.deepEqual(yield* reader.sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* reader.sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`, schemaBefore);
      assert.deepEqual(yield* Effect.promise(() => readFile(path)), beforeReader);

      return yield* Effect.promise(() => readdir(directory));
    }));

    const afterReader = yield* Effect.promise(() => readFile(path));
    assert.deepEqual(afterReader, beforeReader);
    assert.deepEqual(yield* writer.sql`PRAGMA user_version`, [{ user_version: 17 }]);
    assert.deepEqual(yield* writer.sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
    assert.deepEqual(yield* writer.sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`, schemaBefore);
    const filesAfterReader = yield* Effect.promise(() => readdir(directory));

    return {
      bun: Bun.version, sqlite,
      files_before_reader: filesBefore.sort(), files_during_reader: filesDuring.sort(), files_after_reader: filesAfterReader.sort(),
      main_hash_before_reader: sha256(beforeReader), main_hash_after_reader: sha256(afterReader),
      uncheckpointed_wal_bytes: wal.byteLength,
    };
  })).pipe(Effect.provide(BunContext.layer)));

  const receipt = { ...evidence, files_after_writer_close: (await readdir(directory)).sort() };
  const evidenceDirectory = process.env["PULSE_TEST_EVIDENCE_DIR"];

  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(evidenceDirectory, "judge-wal.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  }

} finally {
  await rm(directory, { recursive: true, force: true });
}
