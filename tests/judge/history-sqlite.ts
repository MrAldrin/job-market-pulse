import { BunContext } from "@effect/platform-bun";
import type { FileSystem } from "@effect/platform";
import { Effect, Either, type Scope } from "effect";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { historicalResult, historicalRows, resultContext } from "../../src/lib/server/judge/history-context.ts";
import { getSavedResult } from "../../src/lib/server/judge/results.ts";
import { dashboardSnapshotFromValues } from "../../src/lib/server/judge/dashboard.ts";
import { historySourceListingIds, readDashboardSource } from "../../src/lib/server/judge/history-source.ts";
import { currentSnapshotFromValues } from "../../src/lib/server/judge/snapshot.ts";
import { judgeManifest } from "./fixtures.ts";
import { instant } from "../../src/lib/server/judge/core.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";

const directory = await mkdtemp(join(tmpdir(), "pulse-judge-history-"));
const path = join(directory, "review.sqlite3");
const selection = { profile_id: "invented", directory, path, readonly: false, require_existing: false };
const resultId = "aaaaaaaa-0000-0000-0000-000000000001";
const otherId = "aaaaaaaa-0000-0000-0000-000000000002";
const missing = "aaaaaaaa-0000-0000-0000-000000000003";
const listing = "00000000-0000-0000-0000-000000000001";
const checked = "2026-10-01T10:00:00+00:00";
const imported = "2026-10-19T14:00:00+02:00";
const digest = "a".repeat(64);
const row = { result_id: resultId, listing_id: listing, source_version: checked, input_fingerprint: digest, result_fingerprint: digest, profile_fingerprint: digest, preferences_fingerprint: digest, rules_fingerprint: digest, scoring_version: "v1", value: { id: listing, version: checked, fit: "possible", reason: "Invented retained assessment", evidence: [], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true }, provenance: { assessed_at: checked, is_final_review: true }, candidate: { id: listing, version: checked, title: "Invented historical title", employer: "Synthetic", locations: ["Bergen"], url: `https://arbeidsplassen.nav.no/stillinger/stilling/${listing}`, expires_at: null, detail_missing: false }, imported_at: "payload time must not override row time" };
const payload = JSON.stringify(row);
const run = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) => Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(BunContext.layer)));

try {
  await run(Effect.gen(function* () {
    const state = yield* openJudgeDatabase(selection);
    assert.deepEqual(yield* historicalRows(state), []);
    assert.equal(yield* historicalResult(state, resultId), null);
    assert.equal(yield* resultContext(state, resultId), null);
    assert.equal((yield* state.sql`SELECT name FROM sqlite_master WHERE type='table'`).length, 12);
    // Seed a NEWLY OWNED legacy-format fixture. This is not an application import
    // API, an owner store, or an oracle original reconstructed from golden rows.
    yield* state.sql`CREATE TABLE IF NOT EXISTS historical_review_results (
            result_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
            listing_id TEXT NOT NULL, source_version TEXT NOT NULL,
            input_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            FOREIGN KEY(profile_id) REFERENCES personal_state_profile(profile_id)
        )`;
    yield* state.sql`INSERT INTO historical_review_results VALUES (${otherId},${state.profile_id},${listing},${checked},${digest},${JSON.stringify({ ...row, result_id: otherId, provenance: { assessed_at: null, is_final_review: false } })},${imported})`;
    yield* state.sql`INSERT INTO historical_review_results VALUES (${resultId},${state.profile_id},${listing},${checked},${digest},${payload},${imported})`;
    yield* state.sql`PRAGMA user_version=37`;
    const rows = yield* historicalRows(state);
    assert.deepEqual(rows.map((value) => value["result_id"]), [resultId, otherId]);
    assert.deepEqual(rows.map((value) => value.imported_at), [imported, imported]);
    const saved = yield* historicalResult(state, resultId);
    assert(saved);
    assert.equal(saved.stage, "historical_full_review");
    assert.equal(saved.stale, true);
    assert.equal(saved.stage_version, null);
    assert.equal(saved.prompt_version, null);
    assert.equal(saved.upstream_result_id, null);
    assert.equal(saved.recorded_at, "2026-10-19T12:00:00+00:00");
    assert.deepEqual(saved.value, row.value);
    assert.deepEqual(yield* resultContext(state, `{${resultId.toUpperCase()}}`), { listing_id: listing, source_version: checked, title: "Invented historical title", employer: "Synthetic", provenance: "Historical import; original manifest and artifact SHA-256 bound; model/prompt unknown" });
    assert.equal(yield* historicalResult(state, missing), null);
    assert.equal((yield* getSavedResult(state, resultId))?.stage, "historical_full_review");
    assert.equal((yield* getSavedResult(state, resultId))?.stale, true);
    const sourcePath = join(directory, "source.sqlite3");
    const source = yield* acquireStore(sourcePath, "create");
    yield* initializeSourceStorage(source);
    const currentChecked = "2026-10-20T10:00:00+00:00";
    yield* source`INSERT INTO state VALUES ('checked',${currentChecked}),('caught_up','1')`;
    const manifest = judgeManifest([], currentChecked, state.profile_id);
    const now = yield* instant(currentChecked);
    const values = yield* readDashboardSource(sourcePath, yield* historySourceListingIds(state));
    const dashboard = yield* dashboardSnapshotFromValues(state, currentSnapshotFromValues(state, { manifest, candidates: [], eligible_count: 0 }, now), values, now);
    assert.equal(dashboard.eligible_count, 0);
    assert.equal(dashboard.ranked.length, 1);
    assert.equal(dashboard.ranked[0]?.full_review_result_id, resultId);
    assert.equal(dashboard.ranked[0]?.lifecycle_status, "current_status_unknown");
    assert.equal(dashboard.ranked[0]?.full_review_attempt_status, "historical_import");
    assert.equal(dashboard.ranked[0]?.recommendable, false);
    assert.equal(dashboard.ranked[0]?.review_prompt_version, null);
    assert.deepEqual(dashboard.closed, []);
    assert.equal((yield* state.sql`SELECT * FROM stage_attempts`).length, 0);
    assert.equal((yield* state.sql`SELECT * FROM stage_results`).length, 0);
    assert.equal((yield* state.sql`SELECT name FROM sqlite_master WHERE name='review_result_contexts'`).length, 0);
    yield* state.sql`INSERT INTO historical_review_results VALUES (${missing},${state.profile_id},${listing},${checked},${digest},'1.0',${imported})`;
    assert(Either.isLeft(yield* Effect.either(historicalRows(state))));
  }));
  const before = await readFile(path);
  const files = await readdir(directory);
  await run(Effect.gen(function* () {
    const state = yield* openJudgeDatabase({ ...selection, readonly: true });
    assert.equal((yield* historicalResult(state, resultId))?.stage, "historical_full_review");
    assert.equal((yield* resultContext(state, resultId))?.title, "Invented historical title");
    assert.deepEqual(yield* state.sql`PRAGMA user_version`, [{ user_version: 37 }]);
    assert.deepEqual(yield* state.sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* state.sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }));
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(directory), files);
} finally {
  await rm(directory, { recursive: true, force: true });
}
