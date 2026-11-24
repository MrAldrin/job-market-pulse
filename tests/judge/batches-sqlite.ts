import { BunContext } from "@effect/platform-bun";
import type { FileSystem } from "@effect/platform";
import { Effect, Either, Predicate, Schema, type Scope } from "effect";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewListingMaterial, reviewMaterialFingerprint, reviewTermsFingerprint } from "../../src/lib/server/filter/stage-fingerprint.ts";
import { claimAttempt, transitionAttempt } from "../../src/lib/server/judge/attempts.ts";
import { recordBatch } from "../../src/lib/server/judge/batches.ts";
import { fingerprint, instant } from "../../src/lib/server/judge/core.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { JudgeStateError } from "../../src/lib/server/judge/errors.ts";
import { buildStageInputs } from "../../src/lib/server/judge/inputs.ts";
import { judgeCandidate, judgeManifest, judgeRunContext } from "./fixtures.ts";
import { STAGE_PROMPT_VERSIONS } from "../../src/lib/server/judge/prompts.ts";
import { beginRun, closeRun, finishRun, runCandidates } from "../../src/lib/server/judge/runs.ts";
import { JudgeIds } from "../../src/lib/server/judge/session.ts";
import { dashboardSnapshotFromValues } from "../../src/lib/server/judge/dashboard.ts";
import { currentSnapshotFromValues } from "../../src/lib/server/judge/snapshot.ts";
import { latestAttemptForInputs, runAttempts, runProgress } from "../../src/lib/server/judge/views.ts";
import { completionTransaction, reviewedIds } from "../../src/lib/server/judge/completion.ts";
import { attachReusedResult, getSavedResult, matchingFullReview, reusableResult } from "../../src/lib/server/judge/results.ts";
import { jsonProperty, readAttempt } from "../../src/lib/server/judge/stored.ts";
import { resultContext, savedResultContext } from "../../src/lib/server/judge/history-context.ts";
import { recordReusedFullReviews } from "../../src/lib/server/judge/reuse.ts";
import { historySourceListingIds, readDashboardSource } from "../../src/lib/server/judge/history-source.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";

// Owned stores with real public manifest construction and stage validation.
const directory = await mkdtemp(join(tmpdir(), "pulse-judge-batches-"));
const listing = "00000000-0000-0000-0000-000000000001";
const runId = "00000000-0000-0000-0000-000000000010";
const digest = "a".repeat(64);
const checked = "2026-10-01T10:00:00+00:00";
const now = Either.getOrThrow(instant(checked));
const candidate = judgeCandidate(listing, checked, { title: 'Analyst: "data, quality"', employer: "Invented", expires_at: "2026-11-01T10:00:00+00:00" });
const manifest = judgeManifest([candidate], checked);
const context = judgeRunContext(manifest);
const rawTitle = { schema_version: 1n, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id, assessed_at: "2026-10-01T11:00:00+01:00", complete: true, assessments: [{ id: listing, version: "ignored echoed version", outcome: "advance_to_full_review", reason: "  Matches title  " }] };
const expectedTitleValue = { id: listing, version: checked, outcome: "advance_to_full_review", reason: "Matches title", assessed_at: checked };
const expectedSchema = Schema.decodeUnknownSync(Schema.Struct({ schema_objects: Schema.Array(Schema.Tuple(Schema.String, Schema.String, Schema.String, Schema.NullOr(Schema.String))) }))(JSON.parse(await readFile(new URL("../oracle/basic-run/judge/review-store.json", import.meta.url), "utf8")));
let sequence = 200;

const run = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope | JudgeIds>) => Effect.runPromise(Effect.scoped(program).pipe(
  Effect.provide(BunContext.layer),
  Effect.provideService(JudgeIds, { next: Effect.sync(() => `00000000-0000-0000-0000-${String(sequence++).padStart(12, "0")}`) }),
));

const rejects = <A, E, R>(program: Effect.Effect<A, E, R>, text: string) => Effect.gen(function* () {
  const result = yield* Effect.either(program);
  assert(Either.isLeft(result), text);
  assert(result.left instanceof JudgeStateError);
  assert.match(result.left.message, new RegExp(text));
});

try {
  await run(Effect.gen(function* () {
    const state = yield* openJudgeDatabase({ profile_id: "invented", directory, path: join(directory, "review.sqlite3"), readonly: false, require_existing: false });
    yield* beginRun(state, context, [candidate], now, runId);
    const titleInputs = yield* buildStageInputs(manifest, { stage: "title_screen", prompt_version: STAGE_PROMPT_VERSIONS.title_screen });
    const title = yield* claimAttempt(state, runId, { stage: "title_screen", manifest, inputs: titleInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now });
    const options = { stage: "title_screen", submitted_manifest: manifest, current_manifest: manifest, raw: rawTitle, now } as const;
    yield* rejects(recordBatch(state, title.attempt.attempt_id, options), "running attempt");
    yield* transitionAttempt(state, title.attempt.attempt_id, { status: "running", now });
    yield* rejects(recordBatch(state, title.attempt.attempt_id, { ...options, current_manifest: { ...manifest, rules_fingerprint: "b".repeat(64) } }), "rules changed");
    yield* rejects(recordBatch(state, title.attempt.attempt_id, { ...options, raw: { ...rawTitle, assessments: rawTitle.assessments.map((row) => ({ ...row, outcome: "invented outcome" })) } }), "Unexpected title-screen schema");
    yield* rejects(recordBatch(state, title.attempt.attempt_id, { ...options, current_manifest: { ...manifest, candidates: [] } }), "exact claimed batch");
    const recorded = yield* recordBatch(state, title.attempt.attempt_id, options);
    const screening = recorded[0];
    assert(screening);
    assert.equal(screening.stale, false);
    assert.equal(screening.recorded_at, checked);
    assert.equal(screening.source_version, checked);
    assert.deepEqual(screening.value, expectedTitleValue);
    assert.equal(screening.result_fingerprint, fingerprint(expectedTitleValue));
    assert.equal((yield* getSavedResult(state, screening.result_id))?.stale, true);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now }))?.stale, false);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest }))?.stale, true);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now, max_age_micros: 0n }))?.stale, true);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now: now + 86_400_000_000n }))?.stale, false);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now: now + 86_400_000_001n }))?.stale, true);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now, prompt_versions: new Map() }))?.stale, false);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now, prompt_versions: new Map([["title_screen", "obsolete"]]) }))?.stale, true);
    assert.equal((yield* getSavedResult(state, screening.result_id, { current_manifest: manifest, now, prompt_versions: new Map([["unknown-query-key", "ignored"]]) }))?.stale, true);
    assert.deepEqual(yield* resultContext(state, screening.result_id), { listing_id: listing, source_version: checked, title: candidate.title, employer: candidate.employer, provenance: "Immutable metadata saved with validated staged result" });
    const objects = yield* state.sql<{ type: string; name: string; tbl_name: string; sql: string | null }>`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`;
    assert.deepEqual(objects.map((row) => [row.type, row.name, row.tbl_name, row.sql]), expectedSchema.schema_objects.map(([type, name, table, sql]) =>
      [type, name, table, name === "review_runs" ? sql?.replace(/\)$/u, ", rereview_scope TEXT)") : sql]));
    const contextRows = yield* state.sql<{ context_json: string }>`SELECT context_json FROM review_result_contexts WHERE result_id=${screening.result_id}`;
    assert.equal(contextRows[0]?.context_json, String.raw`{"detail_missing": false, "employer": "Invented", "expires_at": "2026-11-01T10:00:00+00:00", "id": "00000000-0000-0000-0000-000000000001", "locations": ["Oslo"], "review_material": "${reviewMaterialFingerprint(reviewListingMaterial(manifest.candidates[0]!), null)}", "review_terms": "${reviewTermsFingerprint(manifest)}", "title": "Analyst: \"data, quality\"", "url": "https://example.invalid/job", "version": "2026-10-01T10:00:00+00:00"}`);
    assert.equal((yield* recordBatch(state, title.attempt.attempt_id, { ...options, now: now + 100n * 86_400_000_000n }))[0]?.stale, true);
    yield* rejects(recordBatch(state, title.attempt.attempt_id, { ...options, raw: { ...rawTitle, complete: false } }), "cannot be overwritten");

    const provenance = JSON.stringify({ format_version: 1, snapshot_id: digest, expires_at: "2026-10-01T10:01:00+00:00", provenance: null });
    const fullInputs = yield* buildStageInputs(manifest, { stage: "full_review", prompt_version: STAGE_PROMPT_VERSIONS.full_review, source_text_fingerprints: new Map([[listing, digest]]), upstream_result_ids: new Map([[listing, screening.result_id]]), snapshot_provenance: new Map([[listing, provenance]]) });
    const full = yield* claimAttempt(state, runId, { stage: "full_review", manifest, inputs: fullInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review, now });
    yield* transitionAttempt(state, full.attempt.attempt_id, { status: "running", now });
    const rawFull = { schema_version: 1n, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id, assessed_at: checked, complete: true, assessments: [{ id: listing, version: checked, fit: "possible", reason: " Evidence stays unchanged ", evidence: ["Invented"], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true }] };
    const fullOptions = { ...options, stage: "full_review", raw: rawFull } as const;
    yield* rejects(recordBatch(state, full.attempt.attempt_id, { ...fullOptions, current_source_text_fingerprints: new Map([[listing, "b".repeat(64)]]) }), "ad-text fingerprint changed");
    yield* rejects(recordBatch(state, full.attempt.attempt_id, { ...fullOptions, now: now + 120_000_000n }), "detail_inactive");
    const blocked = yield* readAttempt(state, full.attempt.attempt_id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error_code, "detail_inactive");
    assert.equal(blocked.blocked_sub_reason, "detail_inactive");
    assert.equal((yield* state.sql`SELECT result_id FROM stage_results WHERE stage='full_review'`).length, 0);

    const later = "2026-10-01T10:02:00+00:00";
    const freshProvenance = JSON.stringify({ format_version: 1, snapshot_id: digest, expires_at: "2026-10-15T10:00:00+00:00", provenance: null });
    const freshInputs = yield* buildStageInputs(manifest, { stage: "full_review", prompt_version: STAGE_PROMPT_VERSIONS.full_review, source_text_fingerprints: new Map([[listing, digest]]), upstream_result_ids: new Map([[listing, screening.result_id]]), snapshot_provenance: new Map([[listing, freshProvenance]]) });
    const fresh = yield* claimAttempt(state, runId, { stage: "full_review", manifest, inputs: freshInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review, now: now + 120_000_000n });
    yield* transitionAttempt(state, fresh.attempt.attempt_id, { status: "running", now: now + 120_000_000n });
    const results = yield* recordBatch(state, fresh.attempt.attempt_id, { ...fullOptions, raw: { ...rawFull, assessed_at: later }, now: now + 120_000_000n });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.upstream_result_id, screening.result_id);
    assert.equal((yield* runCandidates(state, runId))[0]?.status, "completed");
    assert.equal((yield* finishRun(state, runId, now + 120_000_000n)).status, "completed");
    const fullResult = results[0];
    const fullInput = freshInputs[0];
    const projectedCandidate = manifest.candidates[0];
    assert(fullResult && fullInput && projectedCandidate);
    const snapshotValues = { manifest, candidates: manifest.candidates, eligible_count: 1 };
    const current = yield* currentSnapshotFromValues(state, snapshotValues, now + 120_000_000n);
    assert.equal(current.ranked[0]?.full_review_result_id, fullResult.result_id);
    assert.equal(current.ranked[0]?.recommendable, true);
    assert.equal(current.candidates[0]?.full_review_status, "completed");
    assert.equal(current.pending_count, 0);
    const changedAd = yield* currentSnapshotFromValues(state, snapshotValues, now, { source_text_fingerprints: new Map([[listing, "b".repeat(64)]]) });
    assert.equal(changedAd.candidates[0]?.screening_status, "advance_to_full_review");
    assert.equal(changedAd.candidates[0]?.full_review, null);
    assert.equal(changedAd.pending_count, 1);
    const sourcePath = join(directory, "source.sqlite3");
    const source = yield* acquireStore(sourcePath, "create");
    yield* initializeSourceStorage(source);
    yield* source`INSERT INTO state VALUES ('checked',${manifest.checked_at}),('caught_up','1')`;
    yield* source`INSERT INTO versions VALUES (${listing},${projectedCandidate.version})`;
    yield* source`INSERT INTO ads VALUES (${listing},${projectedCandidate.version},${projectedCandidate.version},${manifest.checked_at},'Do not replace retained display metadata','Synthetic','["Bergen"]','[]',0,'2026-11-01T00:00:00+00:00',NULL)`;
    yield* source`PRAGMA user_version=29`;
    const sourceBefore = yield* Effect.promise(() => readFile(sourcePath));
    const dashboardSource = yield* readDashboardSource(sourcePath, yield* historySourceListingIds(state));
    assert.deepEqual(yield* Effect.promise(() => readFile(sourcePath)), sourceBefore);
    const dashboard = yield* dashboardSnapshotFromValues(state, currentSnapshotFromValues(state, snapshotValues, now), dashboardSource, now);
    assert.equal(dashboard.ranked[0]?.title, manifest.candidates[0]?.title);
    assert.equal(dashboard.ranked[0]?.recommendable, false);
    assert.equal(dashboard.ranked[0]?.screening_status, "advance_to_full_review");
    const changedInputs = { ...snapshotValues, manifest: { ...manifest, profile_fingerprint: "9".repeat(64) } };
    const changedDashboard = yield* dashboardSnapshotFromValues(state, currentSnapshotFromValues(state, changedInputs, now), dashboardSource, now);
    assert(changedDashboard.ranked[0]?.provenance.endsWith("Made with an older profile or prompt"));
    assert.equal(changedDashboard.ranked[0]?.screening_status, "advance_to_full_review");
    assert.equal(changedDashboard.ranked[0]?.older_review, true);
    yield* source`DELETE FROM ads WHERE uuid=${listing}`;
    yield* source`INSERT INTO ad_status_evidence VALUES (${listing},${manifest.checked_at},'DELETED')`;
    const removedSource = yield* readDashboardSource(sourcePath, [listing]);
    const removedDashboard = yield* dashboardSnapshotFromValues(state, currentSnapshotFromValues(state, snapshotValues, now), removedSource, now);
    assert.deepEqual(removedDashboard.ranked, []);
    assert.equal(removedDashboard.closed[0]?.lifecycle_status, "confirmed_closed");
    assert.equal(removedDashboard.closed[0]?.recommendable, false);
    assert.deepEqual(yield* source`PRAGMA user_version`, [{ user_version: 29 }]);
    yield* rejects(readDashboardSource(join(directory, "missing-source.sqlite3"), [listing]), "Cannot read selected Source history");
    const expired = yield* currentSnapshotFromValues(state, { ...snapshotValues, manifest: { ...manifest, checked_at: "2026-10-16T10:00:00+00:00" } }, now + 15n * 86_400_000_000n);
    assert.equal(expired.candidates.length, 0);
    assert.equal(expired.ranked.length, 0);
    assert.equal(expired.closed[0]?.lifecycle_status, "source_expired");
    assert.equal(expired.closed[0]?.recommendable, false);
    assert.equal(expired.eligible_count, 1);
    assert.deepEqual(yield* runProgress(state, runId), { run_id: runId, status: "completed", eligible_count: 1, reused_count: 0, candidate_ids: [listing], completed_count: 1, screened_out_count: 0, screened_count: 0, pending_count: 0, unknown_attempt_count: 0, failed_attempt_count: 0, blocked_attempt_count: 1, model_calls: 3 });
    assert.deepEqual((yield* runAttempts(state, runId)).map((attempt) => attempt.attempt_id), [title.attempt.attempt_id, full.attempt.attempt_id, fresh.attempt.attempt_id]);
    const lookup = { stage: "full_review", manifest, inputs: freshInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review } as const;
    assert.equal((yield* latestAttemptForInputs(state, runId, lookup))?.attempt_id, fresh.attempt.attempt_id);
    assert.equal((yield* latestAttemptForInputs(state, runId, { ...lookup, inputs: freshInputs.map((input) => ({ ...input, snapshot_provenance_json: "not parsed by exact lookup" })) }))?.attempt_id, fresh.attempt.attempt_id);
    assert.equal(yield* latestAttemptForInputs(state, runId, { ...lookup, prompt_version: " " + lookup.prompt_version }), null);
    yield* rejects(latestAttemptForInputs(state, runId, { ...lookup, manifest: { ...manifest, preferences_fingerprint: "c".repeat(64) } }), "personal inputs differ");
    assert.equal((yield* getSavedResult(state, fullResult.result_id, { current_manifest: manifest, now: now + 120_000_000n }))?.stale, true);
    assert.equal((yield* getSavedResult(state, fullResult.result_id, { current_manifest: manifest, now: now + 120_000_000n, source_text_fingerprints: new Map([[listing, digest]]) }))?.stale, false);
    assert.equal((yield* getSavedResult(state, fullResult.result_id, { current_manifest: manifest, now: now + 15n * 86_400_000_000n, max_age_micros: 100n * 86_400_000_000n, source_text_fingerprints: new Map([[listing, digest]]) }))?.stale, true);
    assert.equal(yield* reusableResult(state, "full_review", listing, fullInput.input_fingerprint), null);
    assert.equal((yield* reusableResult(state, "full_review", listing, fullInput.input_fingerprint, now + 120_000_000n))?.result_id, fullResult.result_id);
    assert.equal(yield* reusableResult(state, "full_review", listing, fullInput.input_fingerprint, now + 15n * 86_400_000_000n), null);
    const matching = { snapshot_ids: new Set([digest]), detail_changed: null, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review, now: now + 120_000_000n };
    assert.equal((yield* matchingFullReview(state, projectedCandidate, fullInput, matching))?.result_id, fullResult.result_id);
    assert.equal(yield* matchingFullReview(state, projectedCandidate, fullInput, { ...matching, snapshot_ids: new Set(["b".repeat(64)]) }), null);
    assert.equal(yield* matchingFullReview(state, { ...projectedCandidate, detail_missing: true }, fullInput, matching), null);

    const secondRun = "00000000-0000-0000-0000-000000000011";
    yield* beginRun(state, context, [candidate], now + 120_000_000n, secondRun);
    const fullAttachment = { listing_id: listing, result_id: fullResult.result_id, expected_input_fingerprint: fullResult.input_fingerprint, now: now + 120_000_000n };
    yield* rejects(attachReusedResult(state, secondRun, fullAttachment), "current accepted screening");
    const titleAttachment = { listing_id: listing, result_id: screening.result_id, expected_input_fingerprint: screening.input_fingerprint, current_manifest: manifest };
    yield* rejects(attachReusedResult(state, secondRun, titleAttachment), "explicit time");
    yield* rejects(attachReusedResult(state, secondRun, { ...titleAttachment, now: now + 120_000_000n, current_manifest: { ...manifest, checked_at: "2026-09-01T10:00:00+00:00" } }), "stale or incomplete");
    assert.equal((yield* attachReusedResult(state, secondRun, { ...titleAttachment, now: now + 120_000_000n })).stale, false);
    yield* rejects(attachReusedResult(state, secondRun, { ...fullAttachment, current_manifest: manifest }), "ad-text fingerprint changed");
    yield* state.sql`UPDATE stage_attempt_candidates SET upstream_result_id=${runId} WHERE attempt_id=${fullResult.attempt_id}`;
    yield* rejects(attachReusedResult(state, secondRun, { ...fullAttachment, current_manifest: manifest, current_source_text_fingerprints: new Map([[listing, digest]]) }), "Saved full-review provenance");
    yield* state.sql`UPDATE stage_attempt_candidates SET upstream_result_id=${screening.result_id} WHERE attempt_id=${fullResult.attempt_id}`;
    const attached = yield* attachReusedResult(state, secondRun, { ...fullAttachment, current_manifest: manifest, current_source_text_fingerprints: new Map([[listing, digest]]) });
    assert.equal(attached.result_id, fullResult.result_id);
    assert.equal(attached.stale, false);
    yield* rejects(attachReusedResult(state, secondRun, { ...titleAttachment, now: now + 120_000_000n }), "cannot be overwritten");
    assert.equal((yield* state.sql`SELECT * FROM stage_results`).length, 2);
    assert.equal((yield* finishRun(state, secondRun, now + 120_000_000n)).status, "completed");
    assert.equal((yield* runProgress(state, secondRun)).reused_count, 1);
    assert.equal((yield* runProgress(state, secondRun)).model_calls, 0);
    assert.deepEqual(yield* runAttempts(state, secondRun), []);

    const thirdRun = "00000000-0000-0000-0000-000000000012";
    yield* beginRun(state, context, [candidate], now, thirdRun);
    const changed = { ...manifest, candidates: [{ ...projectedCandidate, title: "Changed metadata" }] };
    yield* rejects(attachReusedResult(state, thirdRun, { ...titleAttachment, now, current_manifest: changed }), "saved run snapshot");
    yield* closeRun(state, thirdRun, "stale", now, true);

    // Equal recorded_at values must rank by actual rowid, not result UUID. This
    // is a real explicitly linked retry of a terminal attempt in a closed run.
    const fourthRun = "00000000-0000-0000-0000-000000000013";
    yield* beginRun(state, context, [candidate], now, fourthRun);
    const retriedTitle = yield* claimAttempt(state, fourthRun, { stage: "title_screen", manifest, inputs: titleInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now, retry_of_attempt_id: title.attempt.attempt_id, owner_confirmed_retry: true, profile_lock_held: true });
    yield* transitionAttempt(state, retriedTitle.attempt.attempt_id, { status: "running", now });
    const replacement = (yield* recordBatch(state, retriedTitle.attempt.attempt_id, options))[0];
    assert(replacement);
    assert.equal(replacement.recorded_at, screening.recorded_at);
    assert.equal(replacement.supersedes_result_id, screening.result_id);
    assert.equal((yield* reusableResult(state, "title_screen", listing, screening.input_fingerprint))?.result_id, replacement.result_id);
    assert.equal((yield* getSavedResult(state, fullResult.result_id, { current_manifest: manifest, now: now + 120_000_000n, source_text_fingerprints: new Map([[listing, digest]]) }))?.stale, true);
    yield* rejects(attachReusedResult(state, fourthRun, fullAttachment), "current accepted screening");
    yield* closeRun(state, fourthRun, "stale", now, true);
    const superseded = yield* currentSnapshotFromValues(state, snapshotValues, now + 120_000_000n);
    assert.deepEqual(superseded.ranked, []);
    assert.equal(superseded.candidates[0]?.full_review, null);
    assert.equal(superseded.pending_count, 1);
    assert.equal((yield* latestAttemptForInputs(state, runId, { stage: "title_screen", manifest, inputs: titleInputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen }))?.attempt_id, retriedTitle.attempt.attempt_id);

    const reuseRun = "00000000-0000-0000-0000-000000000014";
    const reuseNow = now + 180_000_000n;
    yield* beginRun(state, context, [candidate], reuseNow, reuseRun);
    yield* attachReusedResult(state, reuseRun, { listing_id: listing, result_id: replacement.result_id, expected_input_fingerprint: replacement.input_fingerprint, current_manifest: manifest, now: reuseNow });
    const reuseInputs = yield* buildStageInputs(manifest, { stage: "full_review", prompt_version: STAGE_PROMPT_VERSIONS.full_review, source_text_fingerprints: new Map([[listing, digest]]), upstream_result_ids: new Map([[listing, replacement.result_id]]), snapshot_provenance: new Map([[listing, freshProvenance]]) });
    const reuseInput = reuseInputs[0];
    assert(reuseInput);
    const matched = yield* matchingFullReview(state, projectedCandidate, reuseInput, { ...matching, now: reuseNow });
    assert(matched);
    const reuseOptions = { manifest, inputs: reuseInputs, matched: new Map([[listing, matched]]), stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review, now: reuseNow, max_age_micros: 86_400_000_000n };
    const reused = (yield* recordReusedFullReviews(state, reuseRun, reuseOptions))[0];
    assert(reused);
    assert.notEqual(reused.result_id, fullResult.result_id);
    assert.deepEqual(reused.value, fullResult.value);
    assert.equal(reused.recorded_at, "2026-10-01T10:03:00+00:00");
    assert.equal(jsonProperty(yield* savedResultContext(state, reused.result_id), "reused_from_result_id"), fullResult.result_id);
    assert.equal((yield* readAttempt(state, reused.attempt_id)).provenance.call_count, 0);
    assert.deepEqual(yield* recordReusedFullReviews(state, reuseRun, reuseOptions), []);
    assert.equal((yield* runProgress(state, reuseRun)).reused_count, 1);
    assert.equal((yield* runProgress(state, reuseRun)).model_calls, 0);
    yield* finishRun(state, reuseRun, reuseNow);

    // A private namespace unit, as in the frozen recorder's explicit ledger
    // initialization. This does NOT stand in for either real canonical check.
    yield* completionTransaction(state, Effect.gen(function* () {
      assert.equal((yield* state.sql`SELECT name FROM sqlite_master WHERE type='table'`).length, 15);
      assert.deepEqual(yield* reviewedIds(state, manifest), new Set());
      assert.deepEqual(yield* state.sql`PRAGMA foreign_keys`, [{ foreign_keys: 1 }]);
    }));
    const ledgerExpected = yield* Effect.promise(() => Bun.file(new URL("../oracle/basic-run/judge/completion-ledger-initialized.json", import.meta.url)).json());
    const ledgerObjects = yield* state.sql.unsafe("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").values;
    assert.deepEqual(ledgerObjects.map((row) => row[1] === "review_runs" && Predicate.isString(row[3])
      ? [...row.slice(0, 3), row[3].replace(/, rereview_scope TEXT\)$/u, ")")] : row), ledgerExpected.schema_objects);
  }));

  await run(Effect.gen(function* () {
    const state = yield* openJudgeDatabase({ profile_id: "invented", directory, path: join(directory, "rollback.sqlite3"), readonly: false, require_existing: false });
    yield* beginRun(state, context, [candidate], now, runId);
    const inputs = yield* buildStageInputs(manifest, { stage: "title_screen", prompt_version: STAGE_PROMPT_VERSIONS.title_screen });
    const claimed = yield* claimAttempt(state, runId, { stage: "title_screen", manifest, inputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.title_screen, now });
    yield* transitionAttempt(state, claimed.attempt.attempt_id, { status: "running", now });
    yield* state.sql`CREATE VIEW review_result_contexts AS SELECT 'collision' AS collision`;
    yield* rejects(recordBatch(state, claimed.attempt.attempt_id, { stage: "title_screen", submitted_manifest: manifest, current_manifest: manifest, raw: rawTitle, now }), "Cannot access");
    assert.equal((yield* state.sql`SELECT result_id FROM stage_results`).length, 0);
    assert.equal((yield* readAttempt(state, claimed.attempt.attempt_id)).status, "running");
    assert.equal((yield* runCandidates(state, runId))[0]?.status, "pending");
  }));
  await run(Effect.gen(function* () {
    const state = yield* openJudgeDatabase({ profile_id: "invented", directory, path: join(directory, "obsolete-prompt.sqlite3"), readonly: false, require_existing: false });
    yield* beginRun(state, context, [candidate], now, runId);
    const titleInputs = yield* buildStageInputs(manifest, { stage: "title_screen", prompt_version: "obsolete-title-instructions" });
    const title = yield* claimAttempt(state, runId, { stage: "title_screen", manifest, inputs: titleInputs, stage_version: "v1", prompt_version: "obsolete-title-instructions", now });
    yield* transitionAttempt(state, title.attempt.attempt_id, { status: "running", now });
    const screen = (yield* recordBatch(state, title.attempt.attempt_id, { stage: "title_screen", submitted_manifest: manifest, current_manifest: manifest, raw: rawTitle, now }))[0];
    assert(screen);
    assert.equal((yield* getSavedResult(state, screen.result_id, { current_manifest: manifest, now }))?.stale, true);
    assert.equal((yield* getSavedResult(state, screen.result_id, { current_manifest: manifest, now, prompt_versions: new Map([["title_screen", "obsolete-title-instructions"]]) }))?.stale, false);
    yield* rejects(attachReusedResult(state, runId, { listing_id: listing, result_id: screen.result_id, expected_input_fingerprint: screen.input_fingerprint, current_manifest: manifest, now }), "Current stage inputs differ");
    const inputs = yield* buildStageInputs(manifest, { stage: "full_review", prompt_version: STAGE_PROMPT_VERSIONS.full_review, upstream_result_ids: new Map([[listing, screen.result_id]]) });
    const claimed = yield* claimAttempt(state, runId, { stage: "full_review", manifest, inputs, stage_version: "v1", prompt_version: STAGE_PROMPT_VERSIONS.full_review, now });
    assert.equal(claimed.attempt.status, "pending");
    const view = yield* currentSnapshotFromValues(state, { manifest, candidates: manifest.candidates, eligible_count: 1 }, now);
    assert.equal(view.candidates[0]?.older_screening, true);
    assert.equal((yield* state.sql<{ prompt_version: string }>`SELECT prompt_version FROM stage_results`)[0]?.prompt_version, "obsolete-title-instructions");
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
