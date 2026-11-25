import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import { ntfyTransport, NtfyTransport } from "../../src/lib/server/alert/ntfy.ts";
import { decodeModelSettings } from "../../src/lib/server/judge/reviewers.ts";
import { Market } from "../../src/lib/server/market/service.ts";
import { alertScheduledFailure, prepareTopJobsAlert } from "../../src/lib/server/orchestration/ntfy-notifications.ts";
import { snapshotStage } from "../../src/lib/server/orchestration/pipeline-snapshot.ts";
import { ntfyEnabled, readNtfySettings, saveNtfySettings } from "../../src/lib/server/profile/ntfy-settings.ts";
import { ProfileError } from "../../src/lib/server/profile/errors.ts";
import { ProfileFiles } from "../../src/lib/server/profile/files.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { SnapshotCaptureLive } from "../../src/lib/server/snapshot/capture.ts";
import type { SnapshotCandidate } from "../../src/lib/server/snapshot/inputs.ts";
import { SnapshotJsonFile, SnapshotJsonFileLive } from "../../src/lib/server/snapshot/json-file.ts";
import { SnapshotPathsLive } from "../../src/lib/server/snapshot/paths.ts";
import { SnapshotExportLive, SnapshotFacts } from "../../src/lib/server/snapshot/service.ts";
import { projectSnapshotSettings } from "../../src/lib/server/snapshot/settings.ts";
import { SnapshotStore, SnapshotStoreLive } from "../../src/lib/server/snapshot/store.ts";
import { fixtureNarrative, profileServices, syntheticSplit } from "../profile/fixtures.ts";

const listingId = "00000000-0000-4000-8000-000000000001";


const candidate: SnapshotCandidate = {
  listing_id: listingId, title: "Data engineer", employer: "Invented Software AS", locations: ["Oslo"],
  lifecycle_status: "saved_source_unconfirmed", url: `https://arbeidsplassen.nav.no/stillinger/stilling/${listingId}`,
  source_version: "2026-10-19T10:00:00+00:00", application_due: null, expires_at: null, full_review_result_id: null,
  full_review: { fit: "exceptional", reason: "Matches the saved profile", evidence: ["Data pipelines"], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true },
};


const facts = Layer.succeed(SnapshotFacts, {
  load: (profile, now) => Effect.succeed({
    now, profile: { id: profile.profile_id, mode: profile.policy.mode }, funnel: { verified: true, listingIds: new Set([listingId]) },
    judge: { checked_at: now, eligible_count: 1, pending_count: 0, screened_out_count: 0, failed_count: 0, ranked: [candidate], closed: [], firstFound: { [listingId]: now } },
    market: { snapshots: [], taxonomy: { version: "disabled", enabled: false, text_min_hits: 2, families: [], terms: [], title_exclusions: [] }, ads: [], salaries: [] },
  }),
});


const unusedMarket = () => Effect.dieMessage("Settings capture must not call Market history");
const market = Layer.succeed(Market, { readHistory: unusedMarket, recordMarketSnapshot: unusedMarket, salary: unusedMarket, salaryLabels: unusedMarket });
const paths = SnapshotPathsLive.pipe(Layer.provide(BunFileSystem.layer));
const files = SnapshotJsonFileLive.pipe(Layer.provide(paths), Layer.provide(BunFileSystem.layer));
const exporter = SnapshotExportLive.pipe(Layer.provide(facts), Layer.provide(market));


const services = Layer.mergeAll(profileServices, SnapshotStoreLive, files, SnapshotCaptureLive.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, paths, files, SnapshotStoreLive, facts, exporter)),
));

await Effect.runPromise(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const profile = yield* Profile;
  const store = yield* SnapshotStore;
  const json = yield* SnapshotJsonFile;
  const { root, directory, config, profileFile } = yield* syntheticSplit;
  yield* fs.writeFileString(profileFile, `${config}\n[schedule]\nschedule = "every 2 weeks mon 07:15"\nanchor = 2026-10-19\n`);
  const filtersPath = join(directory, "filters.toml");
  const filters = yield* fs.readFileString(filtersPath);
  const longEmployer = "x".repeat(2001);
  yield* fs.writeFileString(filtersPath, filters.replace("[geography]", '[geography]\nhome_postcode = "9917"\narea_postcode = "9918"\nhome_label = "invented-private-origin"').replace("[jobs]", `[jobs]\nexcluded_employers = ["${longEmployer}"]`));
  yield* fs.writeFileString(join(directory, "screen.toml"), 'version = "invented-internal-version"\nacademic = ["invented professor"]\n');
  const selected = yield* profile.load(root, "invented");

  const models = yield* decodeModelSettings(`
[screen]
harness = "pi"
model = "synthetic/screen-model"
effort = "low"
batch_size = 20
[judge]
harness = "claude-code"
model = "judge-model"
effort = "high"
batch_size = 3
[rejudge]
harness = "pi"
model = "synthetic/review-model"
effort = "medium"
batch_size = 10
[calibrate]
harness = "pi"
model = "synthetic/calibration-model"
effort = "minimal"
batch_size = 2
`);

  const topic = "invented-ntfy-topic-012345678";
  const link = "https://dashboard.example.test/app/";
  const { revision } = yield* readNtfySettings(root);
  yield* saveNtfySettings(root, revision, { enabled: true, topic, dashboard_url: link });
  const posts: unknown[] = [];

  const fake = Layer.succeed(NtfyTransport, ntfyTransport(async (_url, init) => {
    posts.push(JSON.parse(String(init.body)));

    return new Response(null, { status: 202 });
  }));

  const prepare = prepareTopJobsAlert(root, "invented").pipe(Effect.provide(fake));
  const notify = yield* prepare;
  const files = yield* ProfileFiles;
  let privateAcl = true;

  const checked = yield* prepare.pipe(Effect.provideService(ProfileFiles, { ...files,
    verifyPrivateFile: () => Effect.suspend(() => privateAcl ? Effect.void : Effect.fail(new ProfileError({ message: "Cannot verify private storage" }))),
  }));

  let admitted: typeof models | null = null;
  const stage = yield* snapshotStage(selected, () => admitted, yield* ntfyEnabled(root));
  assert.equal((yield* stage.run()).returncode, 2);
  admitted = models;
  assert.equal(stage.name, "snapshot");
  const output = join(directory, "dashboard-snapshot.sqlite3");
  const companion = join(directory, "dashboard-snapshot.json");
  const phone = join(root, "local_only", "phone");
  const staged = join(phone, "staged-digests-invented.sqlite");
  yield* fs.makeDirectory(phone);

  const initial = yield* stage.run();
  assert.deepEqual(initial, { returncode: 0, stdout: "Published dashboard snapshot 1", stderr: "", warnings: [] });
  privateAcl = false;
  yield* checked;
  assert.deepEqual(posts, []);
  yield* notify;
  yield* (yield* prepare);
  yield* alertScheduledFailure(root).pipe(Effect.provide(fake));
  assert.deepEqual(posts, [{
    topic, title: "Job Market Pulse: 1 new exceptional match", message: "Data engineer — Invented Software AS", click: link,
  }, {
    topic, title: "Job Market Pulse: scheduled run failed", message: "Check the latest scheduled run on your computer.",
  }]);
  const row = yield* store.readProfile(output, "invented");
  assert(row?.dashboardJson);
  const document = yield* decodeSnapshotDocumentBytes(row.dashboardJson);
  assert(document.schema_version === 6);
  assert.equal(document.run_funnel, null);
  assert.equal(document.jobs[0]?.distance_km, null);
  assert.deepEqual(document.personal_inputs, {
    home_location: {
      label: "invented-private-origin", home_postcode: "9917", area_postcode: null,
      origin: { latitude: 60, longitude: 10, source: "invented" },
    },
    narrative: fixtureNarrative,
  });
  assert.deepEqual(document.settings, {
    policy: { market_only: selected.bundle.policy.market_only, freshness_max_age_hours: 24 },
    filters: {
      radius_km: 40, preferred_municipalities: [], nearby_municipalities: [], excluded_municipalities: [],
      allowed_occupation_categories: ["IT"], excluded_title_terms: ["recruiter"], excluded_employers: null, preferred_terms: ["developer"],
    },
    title_screen: { academic: ["invented professor"], business_development: [], sales: [], tech_words: [] },
    sources: { name: "nav", excludes_finn: true },
    review: {
      screen: { harness: "pi", provider: "synthetic", model: "screen-model", effort: "low", batch_size: 20 },
      judge: { harness: "claude-code", provider: "anthropic", model: "judge-model", effort: "high", batch_size: 3 },
      rejudge: { harness: "pi", provider: "synthetic", model: "review-model", effort: "medium", batch_size: 10 },
      calibrate: { harness: "pi", provider: "synthetic", model: "calibration-model", effort: "minimal", batch_size: 2 },
    },
    schedule: { kind: "every_n_weeks", timezone: "Europe/Oslo", interval: 2, weekday: 0, day_of_month: null, time: "07:15", anchor: "2026-10-19" },
    notifications_enabled: true,
  });
  const jsonText = new TextDecoder().decode(row.dashboardJson);
  assert(!jsonText.includes(topic) && !jsonText.includes(link));
  assert.deepEqual(selected.settings.preferences.excluded_employers, [longEmployer]);
  assert.doesNotMatch(jsonText, /invented-internal-version|source\.sqlite3|profile\.md|fingerprint|x{50}/);

  for (const anchor of [null, "2026-10-20"]) {
    const settings = yield* projectSnapshotSettings({ ...selected, schedule: { ...selected.schedule, anchor } }, models);
    assert.deepEqual(settings.schedule, { ...document.settings.schedule, anchor: null });
  }

  const disabled = yield* projectSnapshotSettings({ ...selected, schedule: { expression: "never", anchor: null } }, models);
  assert.deepEqual(disabled.schedule, { kind: "never", timezone: "Europe/Oslo" });
  const pathModel = yield* projectSnapshotSettings(selected, { ...models, judge: { ...models.judge, model: "invented/../private/model" } });
  assert.equal(pathModel.review.judge.model, null);
  assert.deepEqual(document.shortlist.job_ids, [listingId]);
  assert.equal(row.dashboardBundle, null);
  assert.deepEqual(row.shortlist, { profile_id: "invented", listing_ids: [listingId] });
  assert.equal(row.starred?.jobs[0]?.listing_id, listingId);
  assert.match(new TextDecoder().decode(row.html), /Data engineer/);
  assert.deepEqual(yield* json.read(companion), document);

  if (process.platform !== "win32") assert.equal((yield* fs.stat(output)).mode & 0o777, 0o600);

  if (process.platform !== "win32") assert.equal((yield* fs.stat(companion)).mode & 0o777, 0o600);
  const priorCompanion = yield* fs.readFileString(companion);

  for (const payload of ["", "Broken SQLite test input"]) {
    yield* fs.writeFileString(staged, payload);
    const failed = yield* stage.run();
    assert.deepEqual(failed, { returncode: 2, stdout: "", stderr: "Cannot capture dashboard snapshot." });
    assert.deepEqual(yield* store.latest(output), row);
    assert.equal(yield* fs.readFileString(companion), priorCompanion);
  }

  yield* fs.remove(staged);
  yield* store.publish(staged, { html: new TextEncoder().encode("<p>Old staged digest</p>") });
  yield* fs.writeFileString(companion, "Unrelated test data");
  const partial = yield* stage.run();
  assert.deepEqual(partial, {
    returncode: 0, stdout: "Published dashboard snapshot 2", stderr: "",
    warnings: [
      "Assumption: the selected legacy digest row is treated as this profile's digest; its original profile provenance is unknown.",
      "Snapshot captured, but companion JSON export failed; an older JSON file may remain.",
    ],
  });
  assert.equal(yield* fs.readFileString(companion), "Unrelated test data");
  const retained = yield* store.readProfile(output, "invented");
  const html = new TextDecoder().decode(retained?.html);
  assert.match(html, /Data engineer/);
  assert.doesNotMatch(html, /Old staged digest/);

  const longLabel = "x".repeat(2001);
  const savedFilters = yield* fs.readFileString(filtersPath);
  yield* fs.writeFileString(filtersPath, savedFilters
    .replace('home_label = "invented-private-origin"', `home_label = "${longLabel}"`)
    .replace('origin_source = "invented"', `origin_source = "${longLabel}"`));
  const longLabels = yield* profile.load(root, "invented");
  const longLabelStage = yield* snapshotStage(longLabels, () => models);

  assert.equal((yield* longLabelStage.run()).returncode, 0);
  const latest = yield* store.readProfile(output, "invented");

  assert(latest?.dashboardJson);
  const withLongLabels = yield* decodeSnapshotDocumentBytes(latest.dashboardJson);

  assert.equal(withLongLabels.schema_version, 6);
  assert.deepEqual(withLongLabels.personal_inputs.home_location, {
    label: null, home_postcode: "9917", area_postcode: null, origin: { latitude: 60, longitude: 10, source: null },
  });
}).pipe(Effect.scoped, Effect.provide(services)));
