import { BunContext } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { FileSystem } from "@effect/platform";
import { Cause, Context, Effect, Either, Exit, Layer, type Scope } from "effect";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProvenance, type RunContext } from "../../src/lib/contracts/judge-state.ts";
import { claimAttempt, profileCallsInWindow, recoverInterruptedAttempts, transitionAttempt } from "../../src/lib/server/judge/attempts.ts";
import { openJudgeConnection, openJudgeDatabase, type DatabaseSelection, type JudgeDatabaseHandle } from "../../src/lib/server/judge/database.ts";
import { JudgeStateError } from "../../src/lib/server/judge/errors.ts";
import { attemptDiagnostic, diagnostic, recordAttemptDiagnostic } from "../../src/lib/server/judge/diagnostics.ts";
import { buildStageInputs } from "../../src/lib/server/judge/inputs.ts";
import { judgeCandidate, judgeManifest, judgeRunContext } from "./fixtures.ts";
import { STAGE_PROMPT_VERSIONS } from "../../src/lib/server/judge/prompts.ts";
import { autoRetryListingIds, beginRun, closeRun, finishRun, latestOpenRun, readRun, resumeRun, retryBlockedListingIds, runCandidates } from "../../src/lib/server/judge/runs.ts";
import { instant } from "../../src/lib/server/judge/core.ts";
import { JudgeIds, write } from "../../src/lib/server/judge/session.ts";
import { readAttempt } from "../../src/lib/server/judge/stored.ts";
import { currentSnapshotFromValues } from "../../src/lib/server/judge/snapshot.ts";
import { runAttempts, runProgress } from "../../src/lib/server/judge/views.ts";
import { getSavedResult } from "../../src/lib/server/judge/results.ts";
import { beginModelCall, finishModelCall, modelCallLog } from "../../src/lib/server/judge/model-log.ts";
import { PythonFloat, pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { setFixturePublicRead } from "../orchestration/windows-acl-fixture.ts";

const directory = await mkdtemp(join(tmpdir(), "pulse-judge-state-"));
const path = join(directory, "review.sqlite3");
const listing = "00000000-0000-0000-0000-000000000001";
const listing2 = "00000000-0000-0000-0000-000000000002";
const runId = "00000000-0000-0000-0000-000000000010";
const nextRunId = "00000000-0000-0000-0000-000000000011";
const check = "2026-10-01T10:00:00+00:00";
const now = Either.getOrThrow(instant(check));
const modelLabels = { harness: " pi ", provider: " invented-provider ", model: " offline-fixture ", effort: " medium " };
const candidates = [listing, listing2].map((id) => judgeCandidate(id, check, { expires_at: "2026-11-01T10:00:00Z" }));
const manifest = judgeManifest(candidates, check);
const context: RunContext = judgeRunContext(manifest);
const inputs = Either.getOrThrow(buildStageInputs(manifest, { stage: "title_screen", prompt_version: STAGE_PROMPT_VERSIONS.title_screen }));
const selection: DatabaseSelection = { profile_id: "invented", directory, path, readonly: false, require_existing: false };

let sequence = 100;
const ids = { next: Effect.sync(() => `00000000-0000-0000-0000-${String(sequence++).padStart(12, "0")}`) };

const run = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope | JudgeIds>) =>
  Effect.runPromise(Effect.scoped(program).pipe(
    Effect.provide(BunContext.layer),
    Effect.provideService(JudgeIds, ids),
  ));

const selected = <A, E>(program: (handle: JudgeDatabaseHandle) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope | JudgeIds>, options = selection) =>
  run(Effect.flatMap(openJudgeDatabase(options), program));

const rejects = <A, E, R>(program: Effect.Effect<A, E, R>, text: string) => Effect.gen(function* () {
  const result = yield* Effect.either(program);
  assert(Either.isLeft(result));
  assert(result.left instanceof JudgeStateError);
  assert.match(result.left.message, new RegExp(text));
});

try {
  const previousCwd = process.cwd();
  const previousDataDir = process.env["PULSE_DATA_DIR"];
  process.chdir(directory);
  process.env["PULSE_DATA_DIR"] = join(directory, "inert-data");

  try {
    const { runtime } = await import("../../src/lib/server/runtime.ts");

    try {
      openJudgeDatabase(selection);
      openJudgeConnection(selection, "completion-ledger");
      assert.deepEqual(await readdir(directory), []);
      const { health } = await import("../../src/lib/server/health.ts");
      assert.deepEqual(await runtime.runPromise(health), { status: "ok" });
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await runtime.dispose();
    }
  } finally {
    process.chdir(previousCwd);

    if (previousDataDir === undefined) delete process.env["PULSE_DATA_DIR"];
    else process.env["PULSE_DATA_DIR"] = previousDataDir;
  }

  const missingProfile = { ...selection, directory: join(directory, "absent"), path: join(directory, "absent", "review.sqlite3"), readonly: true };

  if (process.platform === "win32") await run(rejects(openJudgeDatabase(missingProfile), "Cannot safely open"));

  const absent = process.platform === "win32" ? { ...selection, readonly: true } : missingProfile;
  await selected((handle) => Effect.gen(function* () {
    assert.equal(handle.initialized, false);
    const emptySnapshot = yield* currentSnapshotFromValues(handle, { manifest, candidates: manifest.candidates, eligible_count: 2 }, now);
    assert.equal(emptySnapshot.pending_count, 2);
    assert.equal(emptySnapshot.candidates[0]?.full_review_status, "not_eligible");
    assert.deepEqual(emptySnapshot.ranked, []);
    assert.deepEqual(yield* modelCallLog(handle, runId), []);
    assert.equal(yield* getSavedResult(handle, "not-a-uuid"), null);
    assert.equal(yield* attemptDiagnostic(handle, "not-a-uuid"), null);
    assert.deepEqual(yield* handle.sql`PRAGMA query_only`, [{ query_only: 1 }]);
    yield* rejects(readRun(handle, runId), "not initialized");
    yield* rejects(runAttempts(handle, "not-a-uuid"), "not initialized");
    yield* rejects(runProgress(handle, "not-a-uuid"), "not initialized");
    yield* rejects(write(handle, Effect.void), "read-only");
  }), absent);
  assert.deepEqual(await readdir(directory), []);
  await run(rejects(openJudgeDatabase({ ...selection, require_existing: true }), "Cannot safely open"));
  assert.deepEqual(await readdir(directory), []);
  await run(rejects(openJudgeDatabase({ ...selection, readonly: true, require_existing: true }), "Read-only mode"));
  await run(rejects(openJudgeDatabase({ ...selection, profile_id: "WRONG" }), "Cannot safely open"));
  await run(rejects(openJudgeDatabase({ ...selection, path: join(directory, "..", "outside-not-opened.sqlite") }), "escaped"));

  await selected((handle) => Effect.gen(function* () {
    assert.equal(handle.initialized, true);

    for (const field of ["config", "export", "loadExtension"]) assert.equal(Object.hasOwn(handle.sql, field), false);

    assert.deepEqual(yield* handle.sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);
    assert.deepEqual(yield* handle.sql`PRAGMA busy_timeout`, [{ timeout: 5000 }]);
    assert.deepEqual(yield* handle.sql`PRAGMA journal_mode`, [{ journal_mode: "delete" }]);
    assert.deepEqual(yield* handle.sql`PRAGMA synchronous`, [{ synchronous: 2 }]);
    yield* handle.sql`PRAGMA user_version=41`;

    const original = yield* beginRun(handle, context, candidates, now, runId);
    assert.equal(original.status, "running");
    assert.equal((yield* latestOpenRun(handle))?.run_id, runId);
    assert.deepEqual(yield* beginRun(handle, context, [...candidates].reverse(), now, runId), original);
    assert.deepEqual(yield* resumeRun(handle, runId, context, candidates), original);
    yield* rejects(beginRun(handle, context, candidates, now, nextRunId), "open review run");
    yield* rejects(resumeRun(handle, runId, { ...context, rules_fingerprint: "b".repeat(64) }, candidates), "context has changed");
    yield* rejects(resumeRun(handle, runId, context, candidates.map((candidate) => ({ ...candidate, title: "Changed" }))), "snapshot has changed");
    assert.equal((yield* runCandidates(handle, runId)).length, 2);

    const claimed = yield* claimAttempt(handle, runId, { stage: "title_screen", manifest, inputs, stage_version: "1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now });
    assert.equal(claimed.created, true);
    assert.equal(claimed.attempt.provenance.call_count, 0);
    assert.equal(yield* attemptDiagnostic(handle, claimed.attempt.attempt_id), null);
    const received = diagnostic({ text: '{"reason":"invented-contact@example.invalid"}', branch: "received", metadata: { input_tokens: 100 } });
    yield* recordAttemptDiagnostic(handle, `urn:uuid:${claimed.attempt.attempt_id}`, received);
    const savedDiagnostic = yield* attemptDiagnostic(handle, claimed.attempt.attempt_id);
    assert(savedDiagnostic);
    assert.equal(savedDiagnostic["branch"], "received");
    assert.equal(savedDiagnostic["input_tokens"], 100n);
    assert.equal(savedDiagnostic["excerpt"], '{"reason":"[REDACTED]"}');
    yield* recordAttemptDiagnostic(handle, claimed.attempt.attempt_id, { ...received, branch: "accepted", validation_check: "invented prose", excerpt: '{"private_contact":"invented-contact@example.invalid"}' });
    const replacedDiagnostic = yield* attemptDiagnostic(handle, `urn:uuid:${claimed.attempt.attempt_id}`);
    assert(replacedDiagnostic);
    assert.equal(replacedDiagnostic["branch"], "accepted");
    assert.equal(replacedDiagnostic["validation_check"], null);
    assert.equal(replacedDiagnostic["excerpt"], '{"[KEY_0]":"[REDACTED]"}');
    assert.equal(yield* attemptDiagnostic(handle, runId), null);
    yield* rejects(recordAttemptDiagnostic(handle, "not-a-uuid", received), "Identity must be a UUID");
    const again = yield* claimAttempt(handle, runId, { stage: "title_screen", manifest, inputs: [...inputs].reverse(), stage_version: "1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now });
    assert.equal(again.created, false);
    assert.equal(again.attempt.attempt_id, claimed.attempt.attempt_id);
    yield* rejects(beginModelCall(handle, claimed.attempt.attempt_id, "screen", modelLabels, now), "running attempt");
    const running = yield* transitionAttempt(handle, claimed.attempt.attempt_id, { status: "running", now });
    assert.equal(running.provenance.call_count, 1);
    yield* rejects(beginModelCall(handle, claimed.attempt.attempt_id, "invalid-step", modelLabels, now), "Invalid model step");
    yield* rejects(beginModelCall(handle, claimed.attempt.attempt_id, "screen", { ...modelLabels, harness: "pi\nraw" }, now), "bounded plain text");
    yield* rejects(beginModelCall(handle, `urn:uuid:${claimed.attempt.attempt_id}`, "screen", modelLabels, now), "Cannot access");
    assert.deepEqual(yield* modelCallLog(handle, runId), []);
    yield* beginModelCall(handle, claimed.attempt.attempt_id, "screen", modelLabels, now);
    const logged = (yield* modelCallLog(handle, runId))[0];
    assert(logged);
    assert.deepEqual({ harness: logged.harness, provider: logged.provider, model: logged.model, effort: logged.effort }, { harness: "pi", provider: "invented-provider", model: "offline-fixture", effort: "medium" });
    assert.equal(logged.started_at, "2026-10-01T10:00:00.000000+00:00");
    assert.equal(logged.input_tokens, null);
    assert.equal(logged.output_tokens, null);
    assert.equal(logged.wall_time_seconds, null);
    assert.deepEqual(yield* modelCallLog(handle, `urn:uuid:${runId}`), []);
    yield* rejects(beginModelCall(handle, claimed.attempt.attempt_id, "screen", modelLabels, now), "Cannot access");

    for (const value of [true, 1.5, new PythonFloat(1), -1, 1_000_001, 1_000_001n]) {
      yield* rejects(finishModelCall(handle, claimed.attempt.attempt_id, { input_tokens: value, output_tokens: null, wall_time_seconds: null }), "Invalid model token count");
    }

    for (const value of [true, -1, new PythonFloat(Infinity), NaN, "1", 9_223_372_036_854_775_808n]) {
      yield* rejects(finishModelCall(handle, claimed.attempt.attempt_id, { input_tokens: 1, output_tokens: 2, wall_time_seconds: value }), "Invalid model wall time");
    }

    assert.equal((yield* modelCallLog(handle, runId))[0]?.input_tokens, null);
    yield* rejects(finishModelCall(handle, nextRunId, { input_tokens: null, output_tokens: null, wall_time_seconds: null }), "log is missing");
    yield* finishModelCall(handle, claimed.attempt.attempt_id, { input_tokens: 3n, output_tokens: 4, wall_time_seconds: new PythonFloat(1) });
    const used = (yield* modelCallLog(handle, runId))[0];
    assert(used);
    assert.equal(used.input_tokens, 3);
    assert.equal(used.output_tokens, 4);
    assert(used.wall_time_seconds instanceof PythonFloat);
    assert.equal(pythonJson(used.wall_time_seconds), "1.0");
    yield* finishModelCall(handle, `urn:uuid:${claimed.attempt.attempt_id}`, { input_tokens: null, output_tokens: null, wall_time_seconds: null });
    assert.equal((yield* modelCallLog(handle, runId))[0]?.wall_time_seconds, null);
    assert.equal(yield* profileCallsInWindow(handle, now), 1);
    assert.equal(yield* profileCallsInWindow(handle, now + 86_400_000_000n), 0);
    yield* rejects(recoverInterruptedAttempts(handle, now, false), "lock confirmation");
    assert.equal((yield* recoverInterruptedAttempts(handle, now, true, runId)).length, 1);
    assert.equal((yield* recoverInterruptedAttempts(handle, now, true, runId)).length, 0);
    assert.deepEqual(yield* autoRetryListingIds(handle), new Set([listing, listing2]));
    assert.equal((yield* retryBlockedListingIds(handle)).size, 0);
    yield* rejects(transitionAttempt(handle, claimed.attempt.attempt_id, { status: "failed", now, error_code: "invalid_model_json" }), "Terminal attempt");
    yield* rejects(claimAttempt(handle, runId, { stage: "title_screen", manifest, inputs, stage_version: "1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now, retry_of_attempt_id: claimed.attempt.attempt_id }), "owner confirmation");

    const retry = yield* claimAttempt(handle, runId, { stage: "title_screen", manifest, inputs, stage_version: "1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now, retry_of_attempt_id: claimed.attempt.attempt_id, owner_confirmed_retry: true, profile_lock_held: true });
    assert.equal(retry.created, true);
    assert.equal(retry.attempt.attempt_number, 2);
    const blocked = yield* transitionAttempt(handle, retry.attempt.attempt_id, { status: "blocked", now, error_code: "detail_unavailable", sub_reason: "detail_missing" });
    assert.equal(blocked.blocked_sub_reason, "detail_missing");
    assert.equal((yield* transitionAttempt(handle, retry.attempt.attempt_id, { status: "blocked", now, error_code: "detail_unavailable", sub_reason: "detail_inactive" })).blocked_sub_reason, "detail_inactive");
    assert.equal((yield* transitionAttempt(handle, retry.attempt.attempt_id, { status: "blocked", now, error_code: "detail_unavailable", sub_reason: "detail_inactive" })).attempt_id, retry.attempt.attempt_id);
    yield* rejects(transitionAttempt(handle, retry.attempt.attempt_id, { status: "failed", now, error_code: "bad code" }), "safe category");
    assert.equal((yield* finishRun(handle, runId, now)).status, "partial");
    yield* rejects(closeRun(handle, runId, "superseded", now, true), "owner confirmation");
    assert.equal((yield* closeRun(handle, runId, "stale", now, true)).status, "stale");
    assert.equal((yield* closeRun(handle, runId, "stale", now, true)).status, "stale");
    assert.equal(yield* latestOpenRun(handle), null);

    yield* beginRun(handle, context, candidates, now, nextRunId);
    const cross = yield* claimAttempt(handle, nextRunId, { stage: "title_screen", manifest, inputs, stage_version: "1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now, retry_of_attempt_id: retry.attempt.attempt_id, owner_confirmed_retry: true, profile_lock_held: true });
    assert.equal(cross.attempt.attempt_number, 3);
    const budget = { ...emptyProvenance, call_count: 32 };
    yield* transitionAttempt(handle, cross.attempt.attempt_id, { status: "running", now, provenance: budget });
    yield* rejects(transitionAttempt(handle, cross.attempt.attempt_id, { status: "unknown", now, error_code: "submission_unknown", provenance: { ...budget, call_count: 31 } }), "cannot decrease");
    yield* rejects(transitionAttempt(handle, cross.attempt.attempt_id, { status: "running", now, provenance: budget }), "budget is exhausted");
    yield* closeRun(handle, nextRunId, "superseded", now, true, true);
    assert.equal((yield* readAttempt(handle, cross.attempt.attempt_id)).status, "unknown");

    // A nested feature failure rolls back only its savepoint. The outer caller's
    // insert commits and a later operation still uses the same scoped connection.
    yield* handle.sql.withTransaction(Effect.gen(function* () {
      yield* handle.sql`INSERT INTO personal_state_schema VALUES ('caller',1)`;
      yield* rejects(write(handle, Effect.gen(function* () {
        yield* handle.sql`INSERT INTO personal_state_schema VALUES ('inner',1)`;

        return yield* new JudgeStateError({ message: "invented inner failure" });
      })), "invented inner failure");

      assert.deepEqual(yield* handle.sql`SELECT namespace FROM personal_state_schema WHERE namespace IN ('caller','inner')`, [{ namespace: "caller" }]);
    }));
    assert.equal((yield* handle.sql`SELECT namespace FROM personal_state_schema WHERE namespace='caller'`).length, 1);
  }));

  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const before = await readFile(path);
  const files = await readdir(directory);
  await selected((handle) => Effect.gen(function* () {
    assert.equal(handle.initialized, true);
    assert.equal((yield* readRun(handle, runId)).status, "stale");
    const firstAttempt = (yield* runAttempts(handle, runId))[0];
    assert(firstAttempt);
    assert((yield* attemptDiagnostic(handle, firstAttempt.attempt_id)));
    yield* rejects(recordAttemptDiagnostic(handle, firstAttempt.attempt_id, { branch: "unknown" }), "read-only");
    assert.deepEqual(yield* handle.sql`PRAGMA user_version`, [{ user_version: 41 }]);
    assert.deepEqual(yield* handle.sql`PRAGMA query_only`, [{ query_only: 1 }]);
    yield* rejects(beginRun(handle, context, candidates, now), "read-only");
  }), { ...selection, readonly: true });
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(directory), files);

  const other = { ...selection, profile_id: "second", path: join(directory, "second.sqlite3") };
  await selected((handle) => handle.sql`INSERT INTO personal_state_schema VALUES ('target_b',2)`, other);
  const secondBefore = await readFile(other.path);
  const Caller = Context.GenericTag<string>("test/JudgeCaller");

  await run(Effect.gen(function* () {
    const rawContext = yield* Layer.build(SqliteClient.layer({ filename: path, readonly: false, readwrite: true, create: false, disableWAL: true }));
    const external = Context.get(rawContext, SqliteClient.SqliteClient);

    yield* rejects(external.withTransaction(Effect.gen(function* () {
      yield* external`INSERT INTO personal_state_schema VALUES ('outer_uncommitted',1)`;
      const reader = yield* openJudgeDatabase({ ...other, readonly: true });
      assert.deepEqual(yield* reader.sql`SELECT profile_id FROM personal_state_profile`, [{ profile_id: "second" }]);
      assert.deepEqual(yield* reader.sql.unsafe("SELECT profile_id FROM personal_state_profile"), [{ profile_id: "second" }]);
      assert.deepEqual(yield* reader.sql`PRAGMA query_only`, [{ query_only: 1 }]);
      assert.deepEqual(yield* external`PRAGMA query_only`, [{ query_only: 0 }]);
      assert.equal(yield* Caller, "retained");
      yield* reader.sql.withTransaction(Effect.gen(function* () {
        assert.deepEqual(yield* reader.sql`SELECT profile_id FROM personal_state_profile`, [{ profile_id: "second" }]);
      }));

      const writer = yield* openJudgeDatabase({ ...other, require_existing: true });

      const interrupted = yield* Effect.exit(writer.sql.withTransaction(Effect.gen(function* () {
        yield* beginRun(writer, { ...context, candidate_count: 0 }, [], now, runId);

        return yield* Effect.interrupt;
      })));

      assert(Exit.isFailure(interrupted));
      assert(Cause.isInterrupted(interrupted.cause));
      assert.equal((yield* writer.sql`SELECT run_id FROM review_runs WHERE run_id=${runId}`).length, 0);
      yield* beginRun(writer, { ...context, candidate_count: 0 }, [], now, runId);
      assert.equal((yield* writer.sql`SELECT run_id FROM review_runs`).length, 1);
      assert.equal((yield* external`SELECT namespace FROM personal_state_schema WHERE namespace='target_b'`).length, 0);
      yield* external`INSERT INTO personal_state_schema VALUES ('outer_can_still_write',1)`;

      return yield* new JudgeStateError({ message: "invented outer rollback" });
    })).pipe(Effect.provideService(Caller, "retained")), "invented outer rollback");

    assert.equal((yield* external`SELECT namespace FROM personal_state_schema WHERE namespace LIKE 'outer_%'`).length, 0);
    assert.equal((yield* external`SELECT run_id FROM review_runs WHERE run_id=${runId} AND status='running'`).length, 0);
  }));
  assert.notDeepEqual(await readFile(other.path), secondBefore);
  await selected((handle) => Effect.gen(function* () {
    assert.equal((yield* readRun(handle, runId)).status, "running");
    yield* closeRun(handle, runId, "stale", now, true);
  }), other);

  await setFixturePublicRead(path, true);
  await run(rejects(openJudgeDatabase({ ...selection, readonly: true }), process.platform === "win32" ? "Cannot safely open" : "private regular file"));
  await setFixturePublicRead(path, false);
} finally {
  await rm(directory, { recursive: true, force: true });
}
