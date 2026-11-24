import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Clock, Effect, Either, Layer, Predicate } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { GeographyAreasLive } from "../../src/lib/server/filter/geography-service.ts";
import { FilterSourcePackageResources } from "../../src/lib/server/filter/service.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { Profile, ProfileLive } from "../../src/lib/server/profile/service.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { snapshotDigest } from "../../src/lib/server/source/review-text.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";
import { instant } from "../../src/lib/server/judge/core.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { attemptDiagnostic } from "../../src/lib/server/judge/diagnostics.ts";
import { getSavedResult } from "../../src/lib/server/judge/results.ts";
import { readRun } from "../../src/lib/server/judge/runs.ts";
import { modelCallLog } from "../../src/lib/server/judge/model-log.ts";
import { JudgeIdsLive } from "../../src/lib/server/judge/session.ts";
import { readAttempt } from "../../src/lib/server/judge/stored.ts";
import { runAttempts } from "../../src/lib/server/judge/views.ts";
import { readCurrentSnapshot } from "../../src/lib/server/judge/snapshot.ts";
import { createReviewSession } from "../../src/lib/server/judge/workflow-controller.ts";
import { ReviewSource } from "../../src/lib/server/judge/workflow-source.ts";

const services = Layer.mergeAll(ProfileLive.pipe(Layer.provide(ProfileFilesLive)), ProfileFilesLive, GeographyAreasLive, FilterSourcePackageResources, JudgeIdsLive).pipe(Layer.provideMerge(BunContext.layer));
const checked = "2026-10-01T10:00:00+00:00";
const now = Either.getOrThrow(instant("2026-10-01T10:03:00+00:00"));
let currentTime = now;
const fixedClock = Object.assign(Clock.make(), { currentTimeNanos: Effect.sync(() => currentTime * 1000n), currentTimeMillis: Effect.sync(() => Number(currentTime / 1000n)) });
const first = "00000000-0000-0000-0000-000000000001";
const second = "00000000-0000-0000-0000-000000000002";
const reviewer = { id: "judge", harness: "pi", provider: "synthetic", model: "offline", effort: "medium", batch_size: 1, max_budget_usd: null, timeout_seconds: 1800 } as const;
const labels = { harness_label: "pi", provider_label: "synthetic", model_label: "offline", reasoning_level: "medium" };
const usage = { input_tokens: 10, output_tokens: 20 };
let sourceChecks = 0;
let textFetches = 0;
let unavailableTexts = false;
let largeTexts = false;

const source = ReviewSource.of({
  checkFresh: () => Effect.sync(() => { sourceChecks++;

 return [true, checked] as const; }),
  refresh: () => Effect.die("Readonly controller must not refresh"),
  fetchTexts: (_context, _manifest, candidates) => Effect.sync(() => {
    textFetches++;

    if (unavailableTexts) return { available: [], unavailable: candidates.map((candidate) => ({ listing_id: candidate.id, reason: "source_text_unavailable" as const, sub_reason: "description_missing" as const })), request_count: candidates.length };
    const available = [];

    for (const candidate of candidates) {
      const text = largeTexts ? "x".repeat(20_000) : "Synthetic role includes software development.";
      const snapshot = { title: candidate.title, employer: candidate.employer, locations: candidate.locations, expires_at: candidate.expires_at, occupation_categories: candidate.occupation_categories, geography: candidate.geography, geography_reason: candidate.geography_reason };
      const snapshotId = Either.getOrThrow(snapshotDigest(snapshot, text));
      available.push({ listing_id: candidate.id, source_version: candidate.version, text, fingerprint: sha256(text), byte_count: new TextEncoder().encode(text).length, provenance: null, snapshot, snapshot_id: snapshotId, detail_changed: checked });
    }

    return { available, unavailable: [], request_count: candidates.length };
  }),
});

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-controller-" });
  const directory = join(root, "local_only", "profiles", "invented");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(join(directory, "outbox"));
  yield* fs.makeDirectory(join(root, "data"));
  yield* fs.writeFileString(join(directory, "profile.toml"), (yield* initialProfileConfig("invented")).replace("data/REPLACE_WITH_SHARED_FEED.sqlite3", "data/source.sqlite3"));
  yield* fs.writeFileString(join(directory, "filters.toml"), '[geography]\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\nradius_km = 40.0\npreferred_municipalities = ["Invented town"]\n[jobs]\nallowed_occupation_categories = ["IT"]\n');
  yield* fs.writeFileString(join(directory, "judge.toml"), '[jobs]\npreferred_terms = ["developer"]\n');
  yield* fs.writeFileString(join(directory, "screen.toml"), "academic = []\n");
  yield* fs.writeFileString(join(directory, "profile.md"), "## Synthetic profile\nEnjoys building software.\n");
  const db = yield* acquireStore(join(root, "data", "source.sqlite3"), "create");
  yield* initializeSourceStorage(db);
  yield* db`INSERT INTO state VALUES ('checked',${checked}),('caught_up','1')`;

  for (const id of [first, second]) {
    yield* db`INSERT INTO ads VALUES (${id},${checked},${checked},${checked},'Synthetic developer','Synthetic employer','["Invented town"]','[]',0,'2026-12-01T00:00:00+00:00','NAV')`;
    yield* db`INSERT INTO versions VALUES (${id},${checked})`;
    yield* db`INSERT INTO ad_locations VALUES (${id},'[[60.0,10.0]]',0,'{}')`;
    yield* db`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','IT','Software','','')`;
    yield* db`INSERT INTO ad_texts VALUES (${id},'Synthetic role includes software development.',${checked},NULL)`;
  }

  const selected = yield* (yield* Profile).load(root, "invented");
  const context = { root, profile: selected.bundle };
  const store = yield* openJudgeDatabase({ profile_id: "invented", directory, path: selected.bundle.paths.review_db, readonly: false, require_existing: false });
  const options = { store, context, reviewer, host: "synthetic-host", readOnlySource: true, listingIds: [first], maxCandidates: 1 };
  const invalid = yield* Effect.either(createReviewSession({ ...options, maxCalls: 0 }));
  assert(Either.isLeft(invalid));
  assert.equal(sourceChecks, 0);
  const session = yield* createReviewSession(options);
  assert.equal((yield* session.configurationEvent()).type, "configured");
  assert.equal((yield* session.start()).type, "ready");
  const screen = yield* session.nextAction();
  assert(screen.type === "request");
  assert.equal(screen.stage, "title_screen");
  assert(Predicate.isString(screen.attempt_id));
  const screenId = screen.attempt_id;
  const mismatch = yield* Effect.either(session.submit(screenId, { ...labels, model_label: "wrong" }));
  assert(Either.isLeft(mismatch));
  assert.equal((yield* readAttempt(store, screenId)).status, "pending");
  yield* session.submit(screenId, labels);

  // A new controller recovers the genuinely running call before offering retry.
  const resumed = yield* createReviewSession(options);
  const ready = yield* resumed.start();
  assert.equal(ready.run_id, session.runId());
  assert.equal((yield* readAttempt(store, screenId)).status, "unknown");
  const confirmation = yield* resumed.nextAction();
  assert(confirmation.type === "retry_confirmation");
  assert.equal(confirmation.attempt_id, screenId);
  const retried = yield* resumed.confirmRetry(screenId);
  assert(retried.type === "request");
  assert(Predicate.isString(retried.attempt_id));
  const retryId = retried.attempt_id;
  yield* resumed.submit(retryId, labels);
  const invalidReply = yield* resumed.recordResponse(retryId, '{"schema_version":1,"assessments":[]}', usage);
  assert.equal(invalidReply.status, "failed");
  assert.equal((yield* readAttempt(store, retryId)).error_code, "invalid_model_response");
  assert.equal((yield* attemptDiagnostic(store, retryId))?.branch, "validation");
  assert.equal((yield* resumed.nextAction()).type, "retry_confirmation");
  const acceptedRequest = yield* resumed.confirmRetry(retryId);
  assert(acceptedRequest.type === "request");
  assert(Predicate.isString(acceptedRequest.attempt_id));
  assert(Predicate.isString(acceptedRequest.user_prompt));
  const prompt = JSON.parse(acceptedRequest.user_prompt);
  yield* resumed.submit(acceptedRequest.attempt_id, labels);
  const response = { ...prompt.response_template, assessments: prompt.response_template.assessments.map((item: { id: string; version: string }) => ({ id: item.id, version: item.version, outcome: "advance_to_full_review", reason: "Synthetic title is relevant." })) };
  assert.equal((yield* resumed.recordResponse(acceptedRequest.attempt_id, JSON.stringify(response), usage)).status, "completed");
  const full = yield* resumed.nextAction();
  assert(full.type === "request");
  assert.equal(full.stage, "full_review");
  assert.equal(textFetches, 1);
  assert(Predicate.isString(full.attempt_id));
  assert(Predicate.isString(full.user_prompt));
  const fullPrompt = JSON.parse(full.user_prompt);
  yield* resumed.submit(full.attempt_id, labels);
  const fullReply = { ...fullPrompt.response_template, complete: true, assessments: fullPrompt.response_template.assessments.map((item: { id: string; version: string }) => ({ id: item.id, version: item.version, fit: "strong", reason: "Synthetic software development is relevant.", evidence: ["Synthetic role includes software development."], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true })) };
  assert.equal((yield* resumed.recordResponse(full.attempt_id, JSON.stringify(fullReply), usage)).status, "completed");
  assert.equal((yield* resumed.nextAction()).type, "complete");
  const log = yield* modelCallLog(store, resumed.runId() ?? "");
  assert.equal(log.length, 4);
  // Controller admission does not finish actual shell telemetry.
  assert(log.every((entry) => entry.output_tokens === null));

  const firstResult = (yield* readCurrentSnapshot(store, context, now)).ranked[0]?.full_review_result_id;
  assert(firstResult);

  const modelSettings = { screen: reviewer, judge: reviewer, rejudge: { ...reviewer, id: "rejudge", model: "not-used" }, calibrate: reviewer,
    rejudgeOptions: { levels: ["strong"] as const, same_as_judge: true } };

  const repeatOptions = { ...options, listingIds: null, reviewAll: true, rejudge: true, modelSettings };
  const interrupted = yield* createReviewSession(repeatOptions);
  assert.equal((yield* interrupted.start()).type, "ready");
  const pending = yield* interrupted.nextAction();
  assert(pending.type === "request");
  assert.equal(pending.stage, "full_review");

  // Restart before submission. The abandoned request cannot poison this job.
  const repeated = yield* createReviewSession(repeatOptions);
  assert.equal((yield* repeated.start()).type, "ready");
  const repeat = yield* repeated.nextAction();
  assert(repeat.type === "request");
  assert.equal(repeat.reviewer.model, reviewer.model);
  assert.equal(repeat.retry_of_attempt_id, pending.attempt_id);
  yield* repeated.submit(repeat.attempt_id, labels);
  const repeatTemplate = JSON.parse(repeat.user_prompt).response_template;
  assert.deepEqual(repeatTemplate.assessments.map((item: { id: string }) => item.id), [first]);
  const repeatReply = { ...repeatTemplate, complete: true, assessments: [{ ...fullReply.assessments[0], fit: "poor" }] };
  assert.equal((yield* repeated.recordResponse(repeat.attempt_id, JSON.stringify(repeatReply), usage)).status, "completed");
  assert.equal((yield* repeated.nextAction()).type, "complete");
  const original = yield* getSavedResult(store, firstResult);
  assert(original?.stage === "full_review");
  assert.equal((yield* readCurrentSnapshot(store, context, now)).ranked[0]?.full_review_result_id, original.result_id);

  const filters = join(directory, "filters.toml");
  yield* fs.writeFileString(filters, '[geography]\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\nradius_km = 35.0\npreferred_municipalities = ["Another town"]\nexcluded_municipalities = ["Unrelated town"]\n[jobs]\nallowed_occupation_categories = ["IT", "Other"]\nexcluded_employers = ["Other Works"]\nexcluded_title_terms = ["Unrelated role"]\n');
  const filtered = yield* readCurrentSnapshot(store, context, now);
  const kept = filtered.candidates.find((job) => job.listing_id === first);
  assert.equal(kept?.full_review_status, "completed");
  assert.equal(kept?.older_review, false);
  assert.equal(filtered.candidates.find((job) => job.listing_id === second)?.screening_status, "pending");

  // A new Source version with the same reviewed detail can reuse the full result.
  const nextVersion = "2026-10-01T10:00:01+00:00";
  yield* db`UPDATE ads SET changed=${nextVersion} WHERE uuid=${first}`;
  yield* db`UPDATE versions SET changed=${nextVersion} WHERE uuid=${first}`;
  const reuseSession = yield* createReviewSession(options);
  yield* reuseSession.start();
  const reusedAction = yield* reuseSession.nextAction();
  assert(reusedAction.type === "progress");
  assert.equal(reusedAction.status, "reused_result");
  const reusedCompletion = yield* reuseSession.nextAction();
  assert.equal(reusedCompletion.type, "complete");
  assert("reused_count" in reusedCompletion);
  assert.equal(reusedCompletion.reused_count, 1);
  assert.equal((yield* modelCallLog(store, reuseSession.runId() ?? "")).length, 0);
  const repeatAfterMetadata = yield* createReviewSession(repeatOptions);
  assert.equal((yield* repeatAfterMetadata.start()).status, "no_pending_candidates");

  const profilePath = join(directory, "profile.md");
  yield* fs.writeFileString(profilePath, "## Synthetic profile\nPrefers analysis.\n");
  const older = yield* readCurrentSnapshot(store, context, now);
  const olderFirst = older.candidates.find((job) => job.listing_id === first);
  assert.equal(olderFirst?.full_review_status, "completed");
  assert.equal(olderFirst?.older_review, true);
  assert.equal(olderFirst?.older_screening, true);
  const ordinary = yield* createReviewSession(options);
  const ordinaryResult = yield* Effect.either(ordinary.start());
  assert(Either.isLeft(ordinaryResult) && "code" in ordinaryResult.left && ordinaryResult.left.code === "listing_ids_already_reviewed");

  const specific = { ...options, listingIds: null, rereview: [first] };
  const rereview = yield* createReviewSession(specific);
  assert.equal((yield* rereview.start()).type, "ready");
  const normalWhileOpen = yield* createReviewSession(options);
  assert.equal((yield* normalWhileOpen.start()).status, "open_run_review_scope_mismatch");
  const request = yield* rereview.nextAction();
  assert(request.type === "request" && request.stage === "title_screen");
  const template = JSON.parse(request.user_prompt).response_template;
  assert.deepEqual(template.assessments.map((item: { id: string }) => item.id), [first]);
  yield* rereview.submit(request.attempt_id, labels);
  yield* rereview.recordResponse(request.attempt_id, JSON.stringify({ ...template, assessments: template.assessments.map((item: { id: string }) => ({ ...item, outcome: "screened_out", reason: "Synthetic mismatch." })) }), usage);
  assert.equal((yield* rereview.nextAction()).type, "complete");
  const rejected = (yield* readCurrentSnapshot(store, context, now)).candidates.find((job) => job.listing_id === first);
  assert.equal(rejected?.screening_status, "screened_out");
  assert.equal(rejected?.older_screening, false);
  assert.equal(rejected?.full_review, null);

  yield* fs.writeFileString(profilePath, "## Synthetic profile\nEnjoys careful software analysis.\n");
  const allOlder = yield* createReviewSession({ ...specific, rereview: true, maxCalls: 1 });
  assert.equal((yield* allOlder.start()).type, "ready");
  const reconsider = yield* allOlder.nextAction();
  assert(reconsider.type === "request" && reconsider.stage === "title_screen");
  const reconsidered = JSON.parse(reconsider.user_prompt).response_template;
  assert.deepEqual(reconsidered.assessments.map((item: { id: string }) => item.id), [first]);
  yield* allOlder.submit(reconsider.attempt_id, labels);
  assert.equal((yield* allOlder.recordResponse(reconsider.attempt_id, JSON.stringify(reconsidered), usage)).status, "completed");
  assert.equal((yield* allOlder.nextAction()).type, "budget_exhausted");
  yield* allOlder.supersedeRun(true);
  const notAutomatic = yield* createReviewSession(options);
  assert(Either.isLeft(yield* Effect.either(notAutomatic.start())));
  const rollover = yield* createReviewSession({ ...specific, rereview: true });
  assert.equal((yield* rollover.start()).type, "ready");
  const reconsideredFull = yield* rollover.nextAction();
  assert(reconsideredFull.type === "request" && reconsideredFull.stage === "full_review");
  const updated = JSON.parse(reconsideredFull.user_prompt).response_template;
  yield* rollover.submit(reconsideredFull.attempt_id, labels);
  assert.equal((yield* rollover.recordResponse(reconsideredFull.attempt_id, JSON.stringify({ ...updated, complete: true,
    assessments: updated.assessments.map((item: { id: string; version: string }) =>
      ({ ...fullReply.assessments[0], id: item.id, version: item.version })) }), usage)).status, "completed");
  assert.equal((yield* rollover.nextAction()).type, "complete");
  const after = (yield* readCurrentSnapshot(store, context, now)).candidates.find((job) => job.listing_id === first);
  assert.equal(after?.full_review_status, "completed");
  assert.equal(after?.older_review, false);

  const rejectedSecond = yield* createReviewSession(repeatOptions);
  assert.equal((yield* rejectedSecond.start()).type, "ready");
  const rejectedRequest = yield* rejectedSecond.nextAction();
  assert(rejectedRequest.type === "request");
  yield* rejectedSecond.submit(rejectedRequest.attempt_id, labels);
  yield* rejectedSecond.markFailed(rejectedRequest.attempt_id, "model_cost_budget_exceeded");
  const blocked = yield* Effect.either(rejectedSecond.nextAction());
  assert(Either.isLeft(blocked) && "code" in blocked.left && blocked.left.code === "rejudge_attempts_blocked");
  yield* rejectedSecond.supersedeRun(true);

  // A new first assessment for the same listing gets a fresh retry allowance.
  yield* fs.writeFileString(profilePath, "## Synthetic profile\nEnjoys software design.\n");
  const changedJudge = yield* createReviewSession(specific);
  assert.equal((yield* changedJudge.start()).type, "ready");
  const changedScreen = yield* changedJudge.nextAction();
  assert(changedScreen.type === "request" && changedScreen.stage === "title_screen");
  yield* changedJudge.submit(changedScreen.attempt_id, labels);
  yield* changedJudge.recordResponse(changedScreen.attempt_id, JSON.stringify(JSON.parse(changedScreen.user_prompt).response_template), usage);
  const changedFull = yield* changedJudge.nextAction();
  assert(changedFull.type === "request" && changedFull.stage === "full_review");
  const changedTemplate = JSON.parse(changedFull.user_prompt).response_template;
  yield* changedJudge.submit(changedFull.attempt_id, labels);
  assert.equal((yield* changedJudge.recordResponse(changedFull.attempt_id, JSON.stringify({ ...changedTemplate, complete: true,
    assessments: changedTemplate.assessments.map((item: { id: string; version: string }) => ({ ...fullReply.assessments[0], id: item.id, version: item.version })) }), usage)).status, "completed");
  assert.equal((yield* changedJudge.nextAction()).type, "complete");

  const submittedRepeat = yield* createReviewSession(repeatOptions);
  assert.equal((yield* submittedRepeat.start()).type, "ready");
  const submittedRequest = yield* submittedRepeat.nextAction();
  assert(submittedRequest.type === "request" && submittedRequest.retry_of_attempt_id === null);
  yield* submittedRepeat.submit(submittedRequest.attempt_id, labels);
  const interruptedRun = submittedRepeat.runId();
  assert(interruptedRun);

  // A manual selection can recover a leftover second pass, even with a different batch size.
  const manual = yield* createReviewSession({ ...specific, reviewAll: true, modelSettings: {
    ...modelSettings, judge: { ...reviewer, batch_size: 2 },
  } });

  assert.equal((yield* manual.start()).status, "no_pending_candidates");
  assert.equal((yield* readRun(store, interruptedRun)).status, "stale");

  const recovered = yield* readAttempt(store, submittedRequest.attempt_id);
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.error_code, "interrupted_unknown");
  assert.equal(recovered.provenance.call_count, 1);

  // Re-selecting the same first result still cannot submit another second pass.
  yield* fs.writeFileString(filters, (yield* fs.readFileString(filters)).replace("35.0", "34.0"));
  const interruptedRepeat = yield* createReviewSession(repeatOptions);
  assert.equal((yield* interruptedRepeat.start()).type, "ready");
  const unknown = yield* Effect.either(interruptedRepeat.nextAction());
  assert(Either.isLeft(unknown) && "code" in unknown.left && unknown.left.code === "review_outcome_unknown");
  yield* interruptedRepeat.supersedeRun(true);

  const secondSession = yield* createReviewSession({ ...options, listingIds: [second] });
  yield* secondSession.start();
  const secondScreen = yield* secondSession.nextAction();
  assert(secondScreen.type === "request");
  assert(Predicate.isString(secondScreen.attempt_id));
  assert(Predicate.isString(secondScreen.user_prompt));
  const secondPrompt = JSON.parse(secondScreen.user_prompt);
  yield* secondSession.submit(secondScreen.attempt_id, labels);
  // Real Source changes during the call must block, not admit the old response.
  yield* db`UPDATE ads SET title='Changed synthetic title' WHERE uuid=${second}`;
  assert.equal((yield* secondSession.recordResponse(secondScreen.attempt_id, JSON.stringify(secondPrompt.response_template), usage)).status, "blocked");
  assert.equal((yield* readAttempt(store, secondScreen.attempt_id)).error_code, "source_binding_changed");

  for (const scenario of ["budget", "unavailable", "usage", "json", "expiry", "retry-expiry"]) {
    unavailableTexts = false;
    currentTime = now;
    const path = join(directory, `${scenario}.sqlite3`);
    const caseContext = { ...context, profile: { ...context.profile, paths: { ...context.profile.paths, review_db: path } } };
    const caseStore = yield* openJudgeDatabase({ profile_id: "invented", directory, path, readonly: false, require_existing: false });
    const bounded = yield* createReviewSession({ ...options, store: caseStore, context: caseContext, listingIds: [second], maxCalls: scenario === "budget" ? 1 : 32 });
    yield* bounded.start();
    const request = yield* bounded.nextAction();
    assert(request.type === "request");
    yield* bounded.submit(request.attempt_id, labels);

    if (scenario === "usage") {
      assert.equal((yield* bounded.recordResponse(request.attempt_id, "{}", { input_tokens: 1_000_001, output_tokens: 0 })).status, "failed");
      const failed = yield* readAttempt(caseStore, request.attempt_id);
      assert.equal(failed.error_code, "model_token_budget_exceeded");
      assert.equal(failed.provenance.input_tokens, null);
    } else if (scenario === "json") {
      assert.equal((yield* bounded.recordResponse(request.attempt_id, '{"schema_version":1,"schema_version":1}', usage)).status, "failed");
      assert.equal((yield* readAttempt(caseStore, request.attempt_id)).error_code, "invalid_model_json");
    } else {
      const payload = JSON.parse(request.user_prompt);
      yield* bounded.recordResponse(request.attempt_id, JSON.stringify(payload.response_template), usage);
      const fetchesBefore: number = textFetches;
      unavailableTexts = scenario === "unavailable";
      const action = yield* bounded.nextAction();

      if (scenario === "budget") {
        assert.equal(action.type, "budget_exhausted");
        assert.equal(textFetches, fetchesBefore);
        const checksBefore: number = sourceChecks;
        const mismatched = yield* createReviewSession({ ...options, store: caseStore, context: { ...caseContext, profile: { ...caseContext.profile, full_review_batch_size: 2 } }, listingIds: [second] });
        assert(Either.isLeft(yield* Effect.either(mismatched.start())));
        assert.equal(sourceChecks, checksBefore);
      } else if (scenario === "expiry" || scenario === "retry-expiry") {
        assert(action.type === "request");
        yield* bounded.submit(action.attempt_id, labels);
        let confirmationId = action.attempt_id;

        if (scenario === "retry-expiry") {
          yield* bounded.markUnknown(action.attempt_id, "provider_temporary");
          const confirmation = yield* bounded.nextAction();
          assert(confirmation.type === "retry_confirmation");
          confirmationId = confirmation.attempt_id;
        }

        currentTime = Either.getOrThrow(instant("2026-12-01T00:00:00+00:00"));

        const expired = scenario === "expiry"
          ? yield* bounded.recordResponse(action.attempt_id, "{}", usage)
          : yield* bounded.confirmRetry(confirmationId);

        assert("status" in expired);
        assert.equal(expired.status, scenario === "expiry" ? "blocked" : "detail_inactive");
        assert.equal((yield* runAttempts(caseStore, bounded.runId() ?? "")).length, 2);
        currentTime = now;
      } else {
        assert.equal(action.type, "progress");
        assert.equal(action.status, "source_text_unavailable");
        const attempts = yield* runAttempts(caseStore, bounded.runId() ?? "");
        assert.equal(attempts[1]?.status, "blocked");
        assert.equal(attempts[1]?.blocked_sub_reason, "description_missing");
        assert.equal((yield* bounded.nextAction()).type, "complete");
        assert(Either.isLeft(yield* Effect.either(bounded.supersedeRun(false))));
        assert.equal((yield* bounded.supersedeRun(true)).type, "superseded");
        assert.equal(bounded.runId(), null);
      }
    }
  }

  // A bounded full-review request shrinks by candidate, without changing prompts.
  yield* fs.writeFileString(selected.bundle.paths.narrative_file, "p".repeat(95_000));
  largeTexts = true;
  const splitPath = join(directory, "split.sqlite3");
  const splitContext = { ...context, profile: { ...context.profile, paths: { ...context.profile.paths, review_db: splitPath } } };
  const splitStore = yield* openJudgeDatabase({ profile_id: "invented", directory, path: splitPath, readonly: false, require_existing: false });
  const screenReviewer = { ...reviewer, id: "screen", model: "screen-offline", batch_size: 2 };
  const judgeReviewer = { ...reviewer, batch_size: 2 };
  const splitSession = yield* createReviewSession({ ...options, store: splitStore, context: splitContext, listingIds: [first, second], maxCandidates: 2, modelSettings: { screen: screenReviewer, judge: judgeReviewer, rejudge: judgeReviewer, calibrate: judgeReviewer } });
  yield* splitSession.start();
  const splitScreen = yield* splitSession.nextAction();
  assert(splitScreen.type === "request");
  assert.equal(splitScreen.reviewer.model, "screen-offline");
  assert.equal(splitScreen.candidate_count, 2);
  const splitPrompt = JSON.parse(splitScreen.user_prompt);
  yield* splitSession.submit(splitScreen.attempt_id, { ...labels, model_label: "screen-offline" });
  assert.equal((yield* splitSession.recordResponse(splitScreen.attempt_id, JSON.stringify({ ...splitPrompt.response_template, assessments: splitPrompt.candidates.map((item: { id: string; version: string }) => ({ id: item.id, version: item.version, outcome: "advance_to_full_review", reason: "Synthetic title merits reading." })) }), usage)).status, "completed");
  const splitFull = yield* splitSession.nextAction();
  assert(splitFull.type === "request");
  assert.equal(splitFull.reviewer.model, "offline");
  assert.equal(splitFull.candidate_count, 1);
  assert(splitFull.request_bytes <= 128 * 1024);
  yield* splitSession.cancelBeforeSubmit(splitFull.attempt_id);
  yield* splitSession.supersedeRun(true);
})).pipe(Effect.provide(services), Effect.provideService(ReviewSource, source), Effect.withClock(fixedClock)));
