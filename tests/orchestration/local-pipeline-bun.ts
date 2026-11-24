import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer, TestClock } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import legacySnapshotSchema from "../../contracts/snapshot.schema.json";
import type { PipelineDetail } from "../../src/lib/contracts/pipeline-progress.ts";
import { decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { INTEREST_PATTERNS_PATH, loadTitleEvidence } from "../../src/lib/server/filter/evidence-pack.ts";
import { FilterSourcePackageResources } from "../../src/lib/server/filter/service.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { ReviewerHarness, type CallRequest, type CallOutcome } from "../../src/lib/server/judge/harness.ts";
import { HarnessReadiness } from "../../src/lib/server/judge/harness-readiness.ts";
import { ReviewSource, ReviewSourceLive } from "../../src/lib/server/judge/workflow-source.ts";
import { Market } from "../../src/lib/server/market/service.ts";
import { runLocalPipeline, type LocalPipelineOptions } from "../../src/lib/server/orchestration/local-pipeline.ts";
import { pipelineRecords } from "../../src/lib/server/orchestration/pipeline-records.ts";
import { acquireWorkflowLock, withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { AppLive } from "../../src/lib/server/runtime.ts";
import { fingerprintWorkLocations, SUPPORTED_METHOD, SUPPORTED_PROVIDER, workplaceBinding } from "../../src/lib/server/shared/workplace-fingerprint.ts";
import { SnapshotExport } from "../../src/lib/server/snapshot/service.ts";
import { SnapshotJsonFile } from "../../src/lib/server/snapshot/json-file.ts";
import { SnapshotStore } from "../../src/lib/server/snapshot/store.ts";
import { ORIGIN } from "../../src/lib/server/source/core.ts";
import { SourceError } from "../../src/lib/server/source/errors.ts";
import { AddressClientLive } from "../../src/lib/server/source/locations.ts";
import { NavClientLive, SourceHttp, type WireResponse } from "../../src/lib/server/source/nav-client.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { Source, SourceLive } from "../../src/lib/server/source/service.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { sourceAd } from "../filter/fixtures.ts";
import { fixtureTaxonomyText } from "../market/fixture-taxonomy.ts";
import { profileServices, syntheticSplit } from "../profile/fixtures.ts";

const page = "22222222-2222-4222-8222-222222222222";
const listing = "00000000-0000-0000-0000-000000000001";
const peer = "00000000-0000-0000-0000-000000000002";
const changed = "2026-10-19T10:00:00+00:00";
const expires = "2099-01-01T00:00:00+00:00";
const earlierExpiry = "2026-10-19T13:00:00+00:00";
const title = "Software developer";
const employer = "Invented Works";
const municipality = "Invented town";
const workLocations = [{ municipal: municipality, address: "Synthetic Road 1", postalCode: "1234", country: "NORGE" }];
const text = "An invented role building reliable software.";
const tokenUrl = `${ORIGIN}/api/publicToken`;
const firstPageUrl = `${ORIGIN}/api/v1/feed?last`;
const cursorUrl = `${ORIGIN}/api/v1/feed/${page}`;
const detailUrl = `${ORIGIN}/api/v1/feedentry/${listing}`;
const response = (body: string): WireResponse => ({ status: 200, bytes: new TextEncoder().encode(body), headers: {} });
const feeds: string[] = [];
const harnessCalls: string[] = [];
const readinessChecks: string[] = [];
let detailUnavailable = true;
let shortenDetailExpiry = false;
const unknownReceipt = process.argv[2] === "permanent-unknown";

const http = Layer.succeed(SourceHttp, { request: (url) => Effect.suspend(() => {
  if (url === tokenUrl) return Effect.succeed(response("eyJSynthetic.response.only"));

  if (url === firstPageUrl || url === cursorUrl) {
    feeds.push(url);

    return Effect.succeed(response(JSON.stringify({ id: page, items: [], next_url: null })));
  }

  if (url !== detailUrl) return Effect.dieMessage("Unexpected request from the composed pipeline");

  if (detailUnavailable) {
    detailUnavailable = false;

    return Effect.fail(new SourceError({ message: "Synthetic source timeout", transient: true }));
  }

  const detailVersion = shortenDetailExpiry ? "2026-10-19T10:01:00+00:00" : changed;

  return Effect.succeed(response(JSON.stringify({ uuid: listing, status: "ACTIVE", sistEndret: detailVersion, ad_content: {
    uuid: listing, title, employer: { name: employer }, updated: detailVersion, expires: shortenDetailExpiry ? earlierExpiry : expires, description: text,
    workLocations, occupationCategories: [{ level1: "IT", level2: "Software" }],
  } })));
}) });

const clients = Layer.mergeAll(NavClientLive, AddressClientLive).pipe(Layer.provide(http));
const withSource = Layer.mergeAll(AppLive, FilterSourcePackageResources, BunContext.layer, profileServices, clients, SourceLive.pipe(Layer.provide(clients), Layer.provide(BunContext.layer)));
const services = ReviewSourceLive.pipe(Layer.provideMerge(withSource));

const model = (request: CallRequest): CallOutcome => {
  const screen = request.reviewer.id === "screen";
  const rejudge = request.reviewer.id === "rejudge";
  assert.equal(request.executable, screen || rejudge ? "/synthetic/pi" : "/synthetic/claude-code");
  const prompt = JSON.parse(request.user_prompt);
  assert.equal(prompt.candidates[0]?.untrusted_ad_text, screen ? undefined : text);
  harnessCalls.push(request.reviewer.id);

  if (unknownReceipt) {
    assert.deepEqual(prompt.candidates.map((candidate: { id: string }) => candidate.id).sort(), [listing, peer]);

    return { status: "unknown", text: null, error_code: "harness_call_error",
      input_tokens: 10, output_tokens: 6, wall_time_seconds: 0.1, diagnostics: {} };
  }

  const assessment = screen ? { id: listing, version: changed, outcome: "advance_to_full_review", reason: "Software development title" } : {
    id: listing, version: changed, fit: rejudge ? "poor" : "exceptional", reason: rejudge ? "Synthetic second assessment disagrees." : "Direct evidence of software development", evidence: ["Builds reliable software"],
    uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true,
  };

  return { status: "result", text: JSON.stringify({ ...prompt.response_template, complete: true, assessments: [assessment] }), error_code: null,
    input_tokens: 10, output_tokens: 6, wall_time_seconds: 0.1, diagnostics: {} };
};

const modelSettings = ["screen", "judge", "rejudge", "calibrate"].map((step) => step === "judge"
  ? `[${step}]\nharness = "claude-code"\nmodel = "offline"\neffort = "low"\nbatch_size = 1\n`
  : `[${step}]\nharness = "pi"\nmodel = "synthetic/offline"\neffort = "low"\nbatch_size = ${unknownReceipt && step === "screen" ? 2 : 1}\n`).join("\n");

await Effect.runPromise(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, directory } = yield* syntheticSplit;
  const selected = yield* (yield* Profile).load(root, "invented");
  const profile = selected.bundle;
  yield* fs.writeFileString(join(root, "local_only/models.toml"), modelSettings, { mode: 0o600 });
  yield* fs.makeDirectory(join(root, "local_only/config"), { recursive: true });
  yield* fs.writeFileString(join(root, "local_only/config/market_taxonomy.toml"), yield* fixtureTaxonomyText);
  yield* fs.writeFileString(join(root, INTEREST_PATTERNS_PATH), JSON.stringify({
    schema_version: 1, topics: [{ name: "first aid", pattern: "first aid" }], roles: [], source_tags: [],
  }));
  const sourceService = yield* Source;
  const refresh = Effect.flatMap(ReviewSource, (reviewSource) => reviewSource.refresh({ root, profile }));

  // Exercise the Judge-triggered adapter without invoking the live Source.
  const intercepted = yield* refresh.pipe(Effect.provide(ReviewSourceLive), Effect.provideService(Source, {
    ...sourceService,
    refreshPersonal: (_path, _checkpoint, policy) => Effect.sync(() => {
      const row = sourceAd(listing, "first aid instructor", { topics: '["programming"]' });
      assert.equal(policy.rankMissing([row])[0]?.interest_score, 1);

      return { ready: true, checked_at: null, feed_requests: 0, location_requests: 0, location_attempted: 0, location_resolved: 0, location_unknown: 0, occupation_requests: 0, occupation_pending: 0 };
    }),
  }));

  assert.equal(intercepted.ready, true);

  yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* acquireStore(profile.paths.source_db, "create");
    yield* initializeSourceStorage(source);

    for (const id of unknownReceipt ? [listing, peer] : [listing]) {
      yield* source`INSERT INTO ads VALUES (${id},${changed},${changed},${changed},${title},${employer},${JSON.stringify([municipality])},'[]',0,${expires},'NAV')`;
      yield* source`INSERT INTO versions VALUES (${id},${changed})`;
      yield* source`INSERT INTO ad_detail_versions VALUES (${id},${changed},${changed})`;

      const points = '[[60.0,10.0]]';

      const binding = workplaceBinding({ digest: fingerprintWorkLocations({ workLocations }), pointsJson: points, uuid: id,
        sourceVersion: changed, detailChanged: changed, detailSavedChanged: changed, incomplete: false });

      const provenance = JSON.stringify({ provider: SUPPORTED_PROVIDER, method: SUPPORTED_METHOD, source_version: changed,
        retrieved_at: changed, provider_stedfestingverifisert: [true], workplace_fingerprint: binding });

      yield* source`INSERT INTO ad_locations VALUES (${id},${points},0,${provenance})`;
      yield* source`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','IT','Software','','')`;
    }
  }));
  const runPath = join(directory, "local-pipeline-run.json");
  const capturePath = join(directory, "dashboard-snapshot.sqlite3");
  const options = { root, profileId: "invented", once: true };

  const run = (input: LocalPipelineOptions = options) => runLocalPipeline(input).pipe(
    Effect.provideService(HarnessReadiness, { check: (reviewer) => Effect.sync(() => {
      readinessChecks.push(reviewer.id);

      return `/synthetic/${reviewer.harness}`;
    }) }),
    Effect.provideService(ReviewerHarness, { call: (request) => Effect.sync(() => model(request)) }),
  );

  const records = yield* pipelineRecords(root, runPath, "invented");

  if (unknownReceipt) {
    const failed = yield* run();

    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "review");
    assert.equal(failed.exitCode, 2);
    const reset = yield* run({ ...options, reset: true });

    assert.notEqual(reset.run_id, failed.run_id);
    assert.equal(reset.exitCode, 2);
    assert.equal(reset.stage, "review");
    assert.equal(reset.status, "failed");
    assert.equal((yield* records.read)?.failure_detail, "Review outcome is unknown and was not retried.");
    assert.deepEqual(harnessCalls, ["screen"]);
    assert.equal(yield* fs.exists(capturePath), false);

    const updated = "2026-10-20T10:00:00+00:00";

    const update = (id: string) => Effect.scoped(Effect.gen(function* () {
      const source = yield* acquireStore(profile.paths.source_db, "existing");
      yield* source`UPDATE ads SET changed=${updated},title='Updated software role' WHERE uuid=${id}`;
      yield* source`UPDATE versions SET changed=${updated} WHERE uuid=${id}`;
    }));

    // Only the peer changes. A new batch must not repeat the unchanged listing.
    yield* update(peer);
    const regrouped = yield* run({ ...options, reset: true });

    assert.equal(regrouped.status, "failed");
    assert.equal(regrouped.stage, "review");
    assert.equal((yield* records.read)?.failure_detail, "Review outcome is unknown and was not retried.");
    assert.deepEqual(harnessCalls, ["screen"]);

    // A real change to the other listing now makes both inputs new.
    yield* update(listing);
    assert.equal((yield* run({ ...options, reset: true })).stage, "review");
    assert.deepEqual(harnessCalls, ["screen", "screen"]);

    return;
  }

  const details: PipelineDetail[] = [];

  const onProgress: NonNullable<LocalPipelineOptions["onProgress"]> = (event) => Effect.sync(() => {
    if (event.phase === "detail") details.push(event.detail);
  });

  // The primary native run reaches Judge, persists the title decision and stops at the real transient Source error.
  const waiting = yield* run({ ...options, onProgress });
  assert.deepEqual(details, [
    { kind: "nav-events", count: 0 },
    { kind: "eligible-jobs", count: 1 },
    { kind: "review-batch", step: "screen", batch: 1, count: 1 },
  ]);
  const saved = yield* records.read;

  assert.equal(waiting.exitCode, 75);
  assert.equal(waiting.stage, "review");
  assert.equal(saved?.status, "waiting");
  assert.equal(saved?.failed_attempts, 1);
  assert.equal(saved?.failure_detail, "Review stopped (source_temporary).");
  assert.equal(yield* fs.exists(capturePath), false);
  assert.deepEqual(harnessCalls, ["screen"]);
  assert.deepEqual(feeds, [firstPageUrl]);

  // A foreground once before the retry date checks readiness but must not rerun the stages.
  assert.deepEqual(yield* run(), waiting);
  assert.deepEqual(feeds, [firstPageUrl]);
  assert.deepEqual(readinessChecks, ["screen", "judge", "screen", "judge"]);

  yield* TestClock.adjust("5 minutes");
  yield* withInstallationLock(root, (installationLease) => Effect.gen(function* () {
    const profileService = yield* Profile;

    const busy = yield* run().pipe(Effect.provideService(Profile, {
      ...profileService,
      load: () => Effect.dieMessage("Standalone pipeline loaded run inputs before taking the installation lock"),
    }));

    assert.equal(busy.exitCode, 75);
    assert.equal(busy.status, "busy");
    assert.deepEqual(yield* records.read, saved);
    const complete = yield* run({ ...options, installationLease });

    assert.equal(complete.status, "completed");
    assert.equal(complete.run_id, waiting.run_id);
    assert.equal(complete.stage, "snapshot");
    assert.deepEqual(complete.warnings, []);
    assert.equal((yield* run()).status, "busy");
  }));
  assert.deepEqual(readinessChecks, ["screen", "judge", "screen", "judge", "screen", "judge"]);
  assert.deepEqual(feeds, [firstPageUrl, cursorUrl]);
  assert.deepEqual(harnessCalls, ["screen", "judge"]);
  assert.equal((yield* records.read)?.failed_attempts, 1);
  yield* Effect.scoped(acquireWorkflowLock(join(directory, ".personal-review.lock")));

  const output = yield* (yield* SnapshotJsonFile).read(join(directory, "dashboard-snapshot.json"));
  assert(output.schema_version === 6 && output.run_funnel !== null);
  assert.deepEqual(output.run_funnel, {
    nav_events: 0, pool: {
      filters: { pool: 1, area: 0, exclusions: 0, occupation: 0, other: 0 },
      screen: { out: 0, undecided: 0, advanced: 1 },
      judge: { unfinished: 0, fits: { exceptional: 1, strong: 0, possible: 0, unknown: 0, poor: 0 } },
      waiting: 0, failed: 0, listed_review_ids: [listing],
    },
  });
  assert.deepEqual(output.settings.review.judge, { harness: "claude-code", provider: "anthropic", model: "offline", effort: "low", batch_size: 1 });
  assert.deepEqual(output.settings.schedule, { kind: "weekly", timezone: "Europe/Oslo", interval: 1, weekday: 4, day_of_month: null, time: "09:00", anchor: null });
  assert.deepEqual(output.shortlist.job_ids, [listing]);
  assert(Number.isFinite(output.jobs[0]?.distance_km));
  const row = yield* (yield* SnapshotStore).readProfile(capturePath, "invented");

  assert.deepEqual(row?.shortlist?.listing_ids, [listing]);
  assert.equal(row?.dashboardBundle, null);
  const judge = yield* openJudgeDatabase({ profile_id: profile.profile_id, directory, path: profile.paths.review_db, readonly: true, require_existing: false });
  const evidence = yield* loadTitleEvidence(root);
  assert.deepEqual(yield* judge.sql`SELECT DISTINCT scoring_version FROM stage_results`, [{ scoring_version: evidence.scoringVersion }]);
  const history = yield* (yield* Market).readHistory(profile, null);
  const detailed = history.find((entry) => entry.metadata?.series === "detailed");

  assert.equal(history.length, 2);
  assert.equal(detailed?.metadata?.population, 1);
  assert.equal(detailed?.metadata?.text_coverage, 0);
  assert.equal(detailed?.metadata?.occupation_coverage, 1);

  // Off and a nonmatching level do not make any second model calls.
  const modelsPath = join(root, "local_only/models.toml");
  const configureRejudge = (levels: string) => fs.writeFileString(modelsPath, modelSettings.replace("[rejudge]\n", `[rejudge]\nlevels = [${levels}]\nsame_as_judge = false\n`));
  yield* configureRejudge('"poor"');
  assert.equal((yield* run({ ...options, reset: true })).status, "completed");
  assert.deepEqual(harnessCalls, ["screen", "judge"]);

  // The second pass accepts a shorter expiry from newer detail that Source has not saved.
  shortenDetailExpiry = true;
  yield* configureRejudge('"exceptional", "unknown"');
  yield* TestClock.adjust("1 minute");
  details.length = 0;
  const repeatedRun = yield* run({ ...options, reset: true, onProgress });
  assert.deepEqual(details, [
    { kind: "nav-events", count: 0 },
    { kind: "eligible-jobs", count: 1 },
    { kind: "rejudge-started" },
    { kind: "review-batch", step: "rejudge", batch: 1, count: 1 },
  ]);

  assert.equal(repeatedRun.status, "completed", (yield* records.read)?.failure_detail ?? undefined);
  const repeat = yield* (yield* SnapshotJsonFile).read(join(directory, "dashboard-snapshot.json"));
  assert(repeat.schema_version === 6 && repeat.run_funnel !== null);
  assert.deepEqual(repeat.run_funnel.pool?.judge.fits, { exceptional: 0, strong: 0, possible: 0, unknown: 0, poor: 1 });
  assert.deepEqual(repeat.run_funnel.pool?.listed_review_ids, [listing]);
  assert.deepEqual(repeat.settings.rejudge, { levels: ["exceptional", "unknown"], same_as_judge: false });
  assert.equal(repeat.jobs[0]?.assessment.fit, "poor");
  assert.deepEqual(repeat.jobs[0]?.rejudge, { first_fit: "exceptional", first_model: "anthropic/offline", model: "synthetic/offline" });
  assert.notEqual(repeat.jobs[0]?.result_id, output.jobs[0]?.result_id);
  assert.equal(repeat.jobs[0]?.expires_at, earlierExpiry);
  assert.equal(repeat.jobs[0]?.status, "open");
  assert.equal(repeat.jobs[0]?.first_found_at, output.jobs[0]?.first_found_at);
  assert.equal(repeat.jobs[0]?.reviewed_at, repeat.generated_at);
  assert.deepEqual(repeat.shortlist.job_ids, []);
  assert.deepEqual(harnessCalls, ["screen", "judge", "rejudge"]);
  assert(readinessChecks.includes("rejudge"));

  // An admission edit that keeps the listing does not trigger either model.
  const filters = join(directory, "filters.toml");
  yield* fs.writeFileString(filters, (yield* fs.readFileString(filters)).replace("40.0", "35.0"));
  assert.equal((yield* run({ ...options, reset: true })).status, "completed");
  assert.deepEqual(harnessCalls, ["screen", "judge", "rejudge"]);

  yield* configureRejudge("");
  assert.equal((yield* run({ ...options, reset: true })).status, "completed");
  const disabled = yield* (yield* SnapshotJsonFile).read(join(directory, "dashboard-snapshot.json"));
  assert.equal(disabled.jobs[0]?.result_id, repeat.jobs[0]?.result_id);
  assert.deepEqual(harnessCalls, ["screen", "judge", "rejudge"]);

  const exporter = yield* SnapshotExport;

  // A later historical import can win the display row without replacing the
  // compatible Judge result (and its repeat) for the current manifest.
  const historicalId = "aaaaaaaa-0000-4000-8000-000000000001";
  const historyStore = yield* openJudgeDatabase({ profile_id: profile.profile_id, directory, path: profile.paths.review_db, readonly: false, require_existing: true });
  const digest = "a".repeat(64);

  const historical = {
    result_id: historicalId, listing_id: listing, source_version: changed, input_fingerprint: digest, result_fingerprint: digest,
    profile_fingerprint: digest, preferences_fingerprint: digest, rules_fingerprint: digest, scoring_version: "invented",
    value: { fit: "possible", reason: "Invented imported assessment", evidence: [], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true },
    provenance: { assessed_at: repeat.generated_at, is_final_review: true },
    candidate: { title, employer, locations: [municipality], url: `https://arbeidsplassen.nav.no/stillinger/stilling/${listing}`, expires_at: expires, detail_missing: false },
  };

  yield* historyStore.sql`CREATE TABLE IF NOT EXISTS historical_review_results (
    result_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, listing_id TEXT NOT NULL,
    source_version TEXT NOT NULL, input_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, imported_at TEXT NOT NULL
  )`;
  yield* historyStore.sql`INSERT INTO historical_review_results VALUES (${historicalId},${profile.profile_id},${listing},${changed},${digest},${JSON.stringify(historical)},${repeat.generated_at})`;

  const withLaterHistory = yield* exporter.build(profile, {
    now: repeat.generated_at, settings: repeat.settings, personalInputs: repeat.personal_inputs, navEvents: 0,
  });

  assert(withLaterHistory.schema_version === 6 && withLaterHistory.run_funnel !== null);
  assert.equal(withLaterHistory.jobs[0]?.result_id, historicalId);
  assert.deepEqual(withLaterHistory.run_funnel.pool?.judge.fits, { exceptional: 0, strong: 0, possible: 0, unknown: 0, poor: 1 });
  assert.deepEqual(withLaterHistory.run_funnel.pool?.listed_review_ids, []);
  yield* historyStore.sql`DELETE FROM historical_review_results WHERE result_id=${historicalId}`;

  const captureAfterExpiry = yield* exporter.build(profile, {
    now: "2026-10-19T13:01:00+00:00", settings: repeat.settings, personalInputs: repeat.personal_inputs,
  });

  assert(captureAfterExpiry.schema_version === 6);
  assert.equal(captureAfterExpiry.run_funnel, null);
  assert.equal(captureAfterExpiry.counts.open, 0);
  assert.equal(captureAfterExpiry.counts.closed, 1);
  assert.equal(captureAfterExpiry.jobs[0]?.expires_at, earlierExpiry);
  assert.deepEqual(captureAfterExpiry.shortlist.job_ids, []);

  // A Source fact newer than the accepted detail outranks that detail.
  const newerVersion = "2026-10-19T10:02:00+00:00";

  yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* acquireStore(profile.paths.source_db, "existing");

    yield* source`UPDATE ads SET changed=${newerVersion},expires=${expires} WHERE uuid=${listing}`;
    yield* source`UPDATE versions SET changed=${newerVersion} WHERE uuid=${listing}`;
  }));

  const withNewerSource = yield* exporter.build(profile, {
    now: captureAfterExpiry.generated_at, settings: repeat.settings, personalInputs: repeat.personal_inputs,
  });

  assert(withNewerSource.schema_version === 6);
  assert.equal(withNewerSource.jobs[0]?.distance_km, null);
  assert.equal(withNewerSource.jobs[0]?.status, "open");
  assert.equal(withNewerSource.jobs[0]?.expires_at, expires);

  // Closure by application deadline does not hide the newer listing expiry.
  yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* acquireStore(profile.paths.source_db, "existing");

    yield* source`INSERT INTO ad_application_deadlines VALUES (${listing},${newerVersion},'2026-10-19T13:00:00+00:00',0)`;
  }));

  const closedByDeadline = yield* exporter.build(profile, {
    now: captureAfterExpiry.generated_at, settings: repeat.settings, personalInputs: repeat.personal_inputs,
  });

  assert.equal(closedByDeadline.jobs[0]?.status, "closed");
  assert.equal(closedByDeadline.jobs[0]?.expires_at, expires);

  // Every legacy projection keeps its compatible shape for this same re-judged job.
  const legacy = yield* exporter.build(profile, { now: repeat.generated_at, version: 1 });
  const v2 = yield* exporter.build(profile, { now: repeat.generated_at, version: 2 });
  const v3 = yield* exporter.build(profile, { now: repeat.generated_at, settings: repeat.settings });
  const legacyJob = legacy.jobs[0];
  assert(legacyJob);
  assert.deepEqual(Object.keys(legacyJob).sort(), [...legacySnapshotSchema.$defs.job.required].sort());
  assert.equal(legacySnapshotSchema.$defs.job.additionalProperties, false);
  const decode = (json: string) => decodeSnapshotDocumentBytes(new TextEncoder().encode(json));

  for (const doc of [legacy, v2, v3]) {
    assert.equal(doc.jobs[0]?.assessment.fit, "poor");
    assert.equal(doc.jobs[0]?.reviewed_at, doc.jobs[0]?.first_found_at);
    assert.equal(doc.jobs[0] && "rejudge" in doc.jobs[0], false);
    Either.getOrThrowWith(decode(JSON.stringify(doc)), (error) => error);
    assert(Either.isLeft(decode(JSON.stringify({ ...doc, jobs: repeat.jobs }))));
  }

  assert(v3.schema_version === 3);
  assert.equal("rejudge" in v3.settings, false);
  assert(Either.isLeft(decode(JSON.stringify({ ...v3, settings: repeat.settings }))));
  assert(Either.isRight(decode(JSON.stringify(repeat))));
}).pipe(Effect.scoped, Effect.provide(services), Effect.provide(FixedOsloClock)));
