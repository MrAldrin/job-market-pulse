import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunContext } from "@effect/platform-bun";
import type { FileSystem } from "@effect/platform";
import { Effect, Either, type Scope } from "effect";
import { completionTransaction, persistReviewedIds, reviewedIds, type CompletionPersistence } from "../../src/lib/server/judge/completion.ts";
import { openJudgeConnection, openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { JudgeStateError } from "../../src/lib/server/judge/errors.ts";

const directory = await mkdtemp(join(tmpdir(), "pulse-judge-completion-"));
const selection = { profile_id: "invented", directory, path: join(directory, "legacy", "review.sqlite3"), readonly: false, require_existing: false };
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunContext.layer)));

const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) => Effect.gen(function* () {
  const result = yield* Effect.either(effect);
  assert(Either.isLeft(result));
  assert(result.left instanceof JudgeStateError);
  assert.match(result.left.message, new RegExp(message));
});

const listing = "00000000-0000-0000-0000-000000000001";
const version = "2026-10-01T09:00:00+00:00";
const binding = { profile_fingerprint: "a".repeat(64), preferences_fingerprint: "b".repeat(64), rules_fingerprint: "c".repeat(64), scoring_version: "invented-v1" };
const manifest = { ...binding, profile_id: "invented", manifest_id: "d".repeat(64) };
const assessment = { id: listing, version, fit: "possible", reason: "Invented retained review", evidence: ["Invented reviewed text"], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true };

// These are private persistence projections, NOT a canonical validator, a fake
// callback, or proof of the still-blocked public completed-review workflow.
const values: CompletionPersistence = {
  manifest,
  raw_review: { schema_version: 1n, profile_id: "invented", manifest_id: manifest.manifest_id, assessed_at: "2026-10-01T10:00:00.120000+00:00", complete: true, assessments: [assessment] },
  assessments: [{ ...assessment, assessed_at: "2026-10-01T10:00:00.120000+00:00" }],
  recorded_at: "2026-10-01T12:00:00.120000+02:00",
};

try {
  const beforeMissingRead = await readdir(directory);
  await run(Effect.gen(function* () {
    const reader = yield* openJudgeConnection({ ...selection, readonly: true }, "completion-ledger");
    assert.equal(reader.existed, false);
    assert.deepEqual(yield* reviewedIds(reader, binding), new Set());
    assert.deepEqual(yield* reader.sql`PRAGMA query_only`, [{ query_only: 1 }]);
  }));
  assert.deepEqual(await readdir(directory), beforeMissingRead);
  await run(rejects(openJudgeConnection({ ...selection, directory: join(directory, "absent-root"), path: join(directory, "absent-root", "review.sqlite3") }, "completion-ledger"), process.platform === "win32" ? "Cannot safely open" : "Private profile directory is unavailable"));
  assert.deepEqual(await readdir(directory), beforeMissingRead);

  const rollbackPath = join(directory, "rollback", "review.sqlite3");
  await run(Effect.gen(function* () {
    const connection = yield* openJudgeConnection({ ...selection, path: rollbackPath }, "completion-ledger");
    assert.deepEqual(yield* connection.sql`SELECT name FROM sqlite_master WHERE type='table'`, []);
    yield* rejects(completionTransaction(connection, Effect.fail(new JudgeStateError({ message: "owned namespace operation failed" }))), "owned namespace operation failed");
    assert.deepEqual(yield* connection.sql`SELECT name FROM sqlite_master WHERE type='table'`, []);
    assert.deepEqual(yield* connection.sql`PRAGMA user_version`, [{ user_version: 0 }]);
  }));
  // A rolled-back namespace does NOT imply that acquisition never created the
  // private file or parent directory. Both survive, exactly as in the frozen IO.
  const rollbackFile = await stat(rollbackPath);
  const rollbackDirectory = await stat(join(directory, "rollback"));
  assert(rollbackFile.isFile() && rollbackDirectory.isDirectory());

  if (process.platform !== "win32") {
    assert.equal(rollbackFile.mode & 0o777, 0o600);
    assert.equal(rollbackDirectory.mode & 0o777, 0o700);
  }

  await run(Effect.gen(function* () {
    const connection = yield* openJudgeConnection(selection, "completion-ledger");
    assert.deepEqual(yield* connection.sql`SELECT name FROM sqlite_master WHERE type='table'`, []);
    assert.deepEqual(yield* connection.sql`PRAGMA foreign_keys`, [{ foreign_keys: 0 }]);
    assert.deepEqual(yield* connection.sql`PRAGMA synchronous`, [{ synchronous: 2 }]);
    assert.deepEqual(yield* connection.sql`PRAGMA busy_timeout`, [{ timeout: 5000 }]);
    assert.deepEqual(yield* completionTransaction(connection, persistReviewedIds(connection, values)), { status: "recorded", newly_reviewed: 1 });
    assert.deepEqual(yield* reviewedIds(connection, binding), new Set([listing]));
    assert.deepEqual(yield* reviewedIds(connection, { ...binding, preferences_fingerprint: "e".repeat(64) }), new Set());
    assert.deepEqual(yield* completionTransaction(connection, persistReviewedIds(connection, { ...values, recorded_at: "2026-10-02T12:00:00+02:00" })), { status: "already_recorded", newly_reviewed: 0 });
    assert.deepEqual(yield* connection.sql`SELECT recorded_at FROM reviewed_identities`, [{ recorded_at: values.recorded_at }]);
    yield* rejects(completionTransaction(connection, persistReviewedIds(connection, { ...values, raw_review: { changed: true } })), "different completed review");
    yield* rejects(completionTransaction(connection, persistReviewedIds(connection, { ...values, assessments: [assessment, { ...assessment, id: "00000000-0000-0000-0000-000000000002" }] })), "different completed review");
    assert.equal((yield* connection.sql`SELECT * FROM reviewed_identities`).length, 1);
    assert.equal((yield* connection.sql`SELECT name FROM sqlite_master WHERE type='table'`).length, 2);
    assert.deepEqual(yield* connection.sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* connection.sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);

    const expected = yield* Effect.promise(() => Bun.file(new URL("../oracle/basic-run/judge/completion-ledger-initialized.json", import.meta.url)).json());
    const objects = yield* connection.sql.unsafe("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").values;
    assert.deepEqual(objects, expected.schema_objects.filter((row: readonly (string | null)[]) => row[2]?.startsWith("reviewed_")));
  }));

  if (process.platform !== "win32") assert.equal((await stat(selection.path)).mode & 0o777, 0o600);
  const mainBefore = await readFile(selection.path);
  const filesBefore = await readdir(join(directory, "legacy"));
  await run(Effect.gen(function* () {
    const reader = yield* openJudgeConnection({ ...selection, readonly: true }, "completion-ledger");
    assert.deepEqual(yield* reviewedIds(reader, binding), new Set([listing]));
    assert.deepEqual(yield* reader.sql`PRAGMA foreign_keys`, [{ foreign_keys: 0 }]);
    assert.deepEqual(yield* reader.sql`PRAGMA query_only`, [{ query_only: 1 }]);
    yield* rejects(completionTransaction(reader, Effect.void), "read-only");
  }));
  assert.deepEqual(await readFile(selection.path), mainBefore);
  assert.deepEqual(await readdir(join(directory, "legacy")), filesBefore);
  await run(Effect.gen(function* () {
    const foreign = yield* openJudgeConnection({ ...selection, profile_id: "other", readonly: true }, "completion-ledger");
    yield* rejects(reviewedIds(foreign, binding), "profile or schema mismatch");
  }));
  assert.deepEqual(await readFile(selection.path), mainBefore);
  await run(Effect.gen(function* () {
    const incomplete = yield* openJudgeConnection({ ...selection, path: join(directory, "incomplete.sqlite3") }, "completion-ledger");
    yield* incomplete.sql`CREATE TABLE reviewed_identity_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
    yield* incomplete.sql`INSERT INTO reviewed_identity_metadata VALUES ('profile_id','invented'),('schema_version','1'),('extra','retained')`;
    yield* rejects(completionTransaction(incomplete, Effect.void), "profile or schema mismatch");
    assert.deepEqual(yield* incomplete.sql`SELECT name FROM sqlite_master WHERE type='table'`, [{ name: "reviewed_identity_metadata" }]);
    assert.equal((yield* incomplete.sql`SELECT * FROM reviewed_identity_metadata`).length, 3);
  }));

  await run(Effect.gen(function* () {
    const core = yield* openJudgeDatabase({ ...selection, path: join(directory, "base.sqlite3") });
    assert.equal((yield* core.sql`SELECT name FROM sqlite_master WHERE type='table'`).length, 12);
    yield* rejects(reviewedIds(core, binding), "schema is missing");

    const parent = yield* Effect.either(core.sql.withTransaction(Effect.gen(function* () {
      yield* completionTransaction(core, persistReviewedIds(core, values));
      assert.deepEqual(yield* reviewedIds(core, binding), new Set([listing]));
      assert.deepEqual(yield* core.sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);

      return yield* new JudgeStateError({ message: "owned parent rollback" });
    })));

    assert(Either.isLeft(parent));
    assert.equal((yield* core.sql`SELECT name FROM sqlite_master WHERE type='table'`).length, 12);
    yield* rejects(reviewedIds(core, binding), "schema is missing");
    yield* core.sql.withTransaction(Effect.void);
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
