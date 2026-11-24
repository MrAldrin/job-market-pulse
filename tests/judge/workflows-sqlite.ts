import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { GeographyAreasLive } from "../../src/lib/server/filter/geography-service.ts";
import { FilterSourcePackageResources } from "../../src/lib/server/filter/service.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { Profile, ProfileLive } from "../../src/lib/server/profile/service.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { recordSourceStatus } from "../../src/lib/server/source/ingestion.ts";
import { recordCompletedReview } from "../../src/lib/server/judge/completion.ts";
import { instant } from "../../src/lib/server/judge/core.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { readDashboardSnapshot } from "../../src/lib/server/judge/dashboard.ts";
import { JudgeStateError } from "../../src/lib/server/judge/errors.ts";
import { freshJudgeProfile, readCanonicalManifest } from "../../src/lib/server/judge/manifests.ts";
import { readCurrentSnapshot } from "../../src/lib/server/judge/snapshot.ts";
import type { CandidateManifest } from "../../src/lib/contracts/filter.ts";

const services = Layer.mergeAll(ProfileLive.pipe(Layer.provide(ProfileFilesLive)), GeographyAreasLive, FilterSourcePackageResources).pipe(Layer.provideMerge(BunContext.layer));
const checked = "2026-10-01T10:00:00+00:00";
const clock = "2026-10-01T10:03:00+00:00";
const first = "00000000-0000-0000-0000-000000000001";
const second = "00000000-0000-0000-0000-000000000002";
const narrative = "## Synthetic profile\nEnjoys building software and learning.\n";
const filters = '[geography]\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\nradius_km = 40.0\npreferred_municipalities = ["Invented town"]\n[jobs]\nallowed_occupation_categories = ["IT"]\n';

const reply = (manifest: CandidateManifest) => ({
  schema_version: 1n, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id, assessed_at: clock, complete: true,
  assessments: manifest.candidates.map((candidate) => ({ id: candidate.id, version: null, fit: "strong", reason: "Synthetic full-ad evidence supports this work.", evidence: ["Synthetic role includes software development."], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true })),
});

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b9-workflows-" });
  const directory = join(root, "local_only", "profiles", "invented");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(join(directory, "outbox"), { mode: 0o700 });
  yield* fs.makeDirectory(join(root, "data"));
  const config = (yield* initialProfileConfig("invented")).replace("data/REPLACE_WITH_SHARED_FEED.sqlite3", "data/source.sqlite3");
  yield* fs.writeFileString(join(directory, "profile.toml"), config, { mode: 0o600 });
  yield* fs.writeFileString(join(directory, "filters.toml"), filters, { mode: 0o600 });
  yield* fs.writeFileString(join(directory, "judge.toml"), '[jobs]\npreferred_terms = ["developer"]\n', { mode: 0o600 });
  yield* fs.writeFileString(join(directory, "screen.toml"), "academic = []\n", { mode: 0o600 });
  yield* fs.writeFileString(join(directory, "profile.md"), narrative, { mode: 0o600 });

  // Initialize through Source, then insert controlled fixture rows into this NEW
  // store. All manifests and views below use real selected Source snapshots.
  const sourcePath = join(root, "data", "source.sqlite3");
  const source = yield* acquireStore(sourcePath, "create");
  yield* initializeSourceStorage(source);
  yield* source`INSERT INTO state VALUES ('checked',${checked}),('caught_up','1')`;

  for (const id of [first, second]) {
    yield* source`INSERT INTO ads VALUES (${id},${checked},${checked},${checked},'Synthetic developer','Synthetic employer','["Invented town"]','[]',0,'2026-12-01T00:00:00+00:00','NAV')`;
    yield* source`INSERT INTO versions VALUES (${id},${checked})`;
    yield* source`INSERT INTO ad_locations VALUES (${id},'[[60.0,10.0]]',0,'{}')`;
    yield* source`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','IT','Software','','')`;
    yield* source`INSERT INTO ad_texts VALUES (${id},'Synthetic role includes software development.',${checked},NULL)`;
  }

  const profileService = yield* Profile;
  const selected = yield* profileService.load(root, "invented");
  const context = { root, profile: selected.bundle };
  const now = yield* instant(clock);
  const selection = { profile_id: "invented", directory, path: selected.bundle.paths.review_db, readonly: false, require_existing: false };
  const initial = yield* freshJudgeProfile(context);
  const manifest = yield* readCanonicalManifest(initial, now, { candidateIds: [first] });
  assert.equal(manifest.eligible_count, 2);
  assert.equal(manifest.candidate_count, 1);
  const raw = reply(manifest);

  yield* Effect.scoped(Effect.gen(function* () {
    const reader = yield* openJudgeDatabase({ ...selection, readonly: true });
    const current = yield* readCurrentSnapshot(reader, context, now);
    const dashboard = yield* readDashboardSnapshot(reader, context, now);
    assert.equal(current.eligible_count, 2);
    assert.equal(current.pending_count, 2);
    assert.equal(dashboard.eligible_count, 2);
    assert.equal(dashboard.ranked.length, 0);
  }));
  assert.equal(yield* fs.exists(selection.path), false);

  // A real changed active input invalidates the reply before any writer/file.
  yield* fs.writeFileString(selected.bundle.paths.narrative_file, narrative + "Now prefers backend work.\n");
  assert(Either.isLeft(yield* Effect.either(recordCompletedReview(context, raw, { now }))));
  assert.equal(yield* fs.exists(selection.path), false);
  yield* fs.writeFileString(selected.bundle.paths.narrative_file, narrative);

  // The selected bundle stays authoritative. Neither pass re-enters config,
  // unselected Screen, outbox readiness, or a legacy preferences loader.
  yield* fs.remove(join(directory, "profile.toml"));
  yield* fs.remove(join(directory, "screen.toml"));
  yield* fs.remove(join(directory, "outbox"), { recursive: true });
  assert(Either.isLeft(yield* Effect.either(profileService.load(root, "invented"))));
  const completed = yield* recordCompletedReview(context, raw, { now, recorded_at: "2026-10-01T12:03:00+02:00" });
  assert.equal(completed.status, "recorded");
  assert.equal(completed.recorded_count, 1);
  assert.equal(completed.reviewed_count, 1);
  assert.equal(completed.remaining_count, 1);
  assert.equal((yield* recordCompletedReview(context, raw, { now })).status, "already_recorded");

  const state = yield* openJudgeDatabase(selection);
  assert.deepEqual(yield* state.sql`SELECT listing_id, recorded_at FROM reviewed_identities`, [{ listing_id: first, recorded_at: "2026-10-01T12:03:00+02:00" }]);
  const next = yield* readCanonicalManifest(yield* freshJudgeProfile(context), now, { candidateIds: [second] });

  const rolledBack = yield* Effect.either(state.sql.withTransaction(Effect.gen(function* () {
    assert.equal((yield* recordCompletedReview(context, reply(next), { now, connection: state })).status, "recorded");

    return yield* new JudgeStateError({ message: "Intentional caller transaction rollback" });
  })));

  assert(Either.isLeft(rolledBack));
  assert.deepEqual(yield* state.sql`SELECT listing_id FROM reviewed_identities`, [{ listing_id: first }]);

  // Retained history is fixture data, not an application import API. Bind its
  // known metadata to the actual first manifest and keep unknown model facts.
  const resultId = "aaaaaaaa-0000-0000-0000-000000000001";
  const candidate = manifest.candidates[0];
  assert(candidate);
  const historical = { result_id: resultId, listing_id: first, source_version: checked, input_fingerprint: manifest.manifest_id, result_fingerprint: manifest.manifest_id, profile_fingerprint: manifest.profile_fingerprint, preferences_fingerprint: manifest.preferences_fingerprint, rules_fingerprint: manifest.rules_fingerprint, scoring_version: manifest.scoring_version, value: { ...raw.assessments[0], version: checked }, provenance: { assessed_at: clock, is_final_review: true }, candidate: { ...candidate, title: "Saved synthetic title" } };
  yield* state.sql`CREATE TABLE historical_review_results (
            result_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
            listing_id TEXT NOT NULL, source_version TEXT NOT NULL,
            input_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            FOREIGN KEY(profile_id) REFERENCES personal_state_profile(profile_id)
        )`;
  yield* state.sql`INSERT INTO historical_review_results VALUES (${resultId},'invented',${first},${checked},${manifest.manifest_id},${JSON.stringify(historical)},${clock})`;
  const dashboard = yield* readDashboardSnapshot(state, context, now);
  assert.equal(dashboard.ranked[0]?.full_review_result_id, resultId);
  assert.equal(dashboard.ranked[0]?.title, "Saved synthetic title");
  assert.equal(dashboard.ranked[0]?.recommendable, false);
  assert.equal(dashboard.ranked[0]?.review_prompt_version, null);

  yield* fs.writeFileString(selected.bundle.paths.narrative_file, narrative + "Now prefers backend work.\n");
  const changed = yield* readDashboardSnapshot(state, context, now);
  assert.notEqual(changed.profile_fingerprint, manifest.profile_fingerprint);
  assert.equal(changed.ranked[0]?.full_review_result_id, resultId);
  assert.equal(changed.ranked[0]?.recommendable, false);
  yield* fs.writeFileString(selected.bundle.paths.narrative_file, "");
  const unverified = yield* readDashboardSnapshot(state, context, now);
  assert.equal(unverified.eligibility_verified, false);
  assert.equal(unverified.ranked[0]?.full_review_result_id, resultId);
  assert.equal(unverified.ranked[0]?.recommendable, false);
  yield* fs.writeFileString(selected.bundle.paths.narrative_file, narrative + "Now prefers backend work.\n");
  const removedAt = "2026-10-01T10:05:00+00:00";
  yield* source`DELETE FROM ads WHERE uuid=${first}`;
  yield* source`UPDATE versions SET changed=${removedAt} WHERE uuid=${first}`;
  yield* recordSourceStatus(source, first, removedAt, "DELETED");
  yield* source`UPDATE state SET value=${removedAt} WHERE key='checked'`;
  const removed = yield* readDashboardSnapshot(state, context, yield* instant("2026-10-01T10:06:00+00:00"));
  assert.equal(removed.eligible_count, 1);
  assert.equal(removed.ranked.length, 0);
  assert.equal(removed.closed[0]?.full_review_result_id, resultId);
  assert.equal(removed.closed[0]?.lifecycle_status, "confirmed_closed");
  assert.equal(removed.closed[0]?.title, "Saved synthetic title");
})).pipe(Effect.provide(services)));
