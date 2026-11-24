import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer, Schema } from "effect";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AppLive } from "../../src/lib/server/runtime.ts";
import { SnapshotV2 } from "../../src/lib/contracts/snapshot.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { SettingsConverter, SettingsConverterLive } from "../../src/lib/server/profile/split-settings.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { readCurrentSnapshot } from "../../src/lib/server/judge/snapshot.ts";
import { instant } from "../../src/lib/server/judge/core.ts";
import { readFullReviewFirstFound } from "../../src/lib/server/judge/views.ts";
import { SnapshotExport } from "../../src/lib/server/snapshot/service.ts";
import { snapshotJsonBytes } from "../../src/lib/server/snapshot/serialization.ts";
import { readSnapshotMarketInputs } from "../../src/lib/server/snapshot/market-inputs.ts";
import { Market, recordingPath } from "../../src/lib/server/market/service.ts";
import { initializeMarketAggregates, replaceSnapshot } from "../../src/lib/server/market/record-store.ts";
import { fixtureTaxonomyText } from "../market/fixture-taxonomy.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { compareText } from "../oracle/compare.ts";
import { withReplayedSource } from "../oracle/source.ts";

const converter = SettingsConverterLive.pipe(Layer.provide(ProfileFilesLive), Layer.provide(BunContext.layer));

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* withReplayedSource("resume-run", (source) => Effect.gen(function* () {
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b6-judge-adapter-" });
    const directory = join(root, "local_only/profiles/invented");
    yield* fs.makeDirectory(join(directory, "outbox"), { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(join(root, "data"), { mode: 0o700 });
    yield* fs.makeDirectory(join(root, "local_only/config"));
    yield* fs.writeFileString(join(root, "local_only/config/market_taxonomy.toml"), yield* fixtureTaxonomyText);
    const databases = yield* source<{ name: string; file: string }>`PRAGMA database_list`;
    const main = databases.find((database) => database.name === "main");
    assert(main);
    yield* fs.copyFile(main.file, join(root, "data/source.sqlite3"));
    const config = (yield* initialProfileConfig("invented")).replace("data/REPLACE_WITH_SHARED_FEED.sqlite3", "data/source.sqlite3");
    const input = yield* fs.readFileString("tests/fixtures/port-oracle/basic-run/inputs/profile.json").pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Schema.Struct({ preferences: Schema.String, narrative: Schema.String })))));
    yield* fs.writeFileString(join(directory, "profile.toml"), config, { mode: 0o600 });
    yield* fs.writeFileString(join(directory, "preferences.toml"), input.preferences, { mode: 0o600 });
    yield* fs.writeFileString(join(directory, "profile.md"), input.narrative, { mode: 0o600 });
    yield* fs.copyFile("config/title_exclusions.neutral.toml", join(root, "explicit-rules.toml"));
    yield* (yield* SettingsConverter).split({ root, profileId: "invented", titleRules: join(root, "explicit-rules.toml") });
    const selected = yield* (yield* Profile).load(root, "invented");
    const profile = selected.bundle;
    const selection = { profile_id: profile.profile_id, directory, path: profile.paths.review_db, readonly: true, require_existing: false };
    yield* Effect.scoped(Effect.gen(function* () {
      const absent = yield* openJudgeDatabase(selection);
      assert.deepEqual(yield* readFullReviewFirstFound(absent), []);
    }));
    assert.equal(yield* fs.exists(selection.path), false);
    const original = gunzipSync(Buffer.from(yield* fs.readFileString("tests/fixtures/judge/original-python-review.sqlite3.gz.base64"), "base64"));
    yield* fs.writeFile(selection.path, original, { flag: "wx", mode: 0o600 });

    yield* Effect.scoped(Effect.gen(function* () {
      const legacy = yield* openJudgeDatabase(selection);
      const current = yield* readCurrentSnapshot(legacy, { root, profile }, yield* instant("2026-10-19T12:00:00+00:00"));
      assert.equal(current.pending_count, 0);
      assert.equal(current.screened_out_count, 8);
      assert.equal(current.candidates.filter((job) => job.older_review && job.full_review_status === "completed").length, 5);
    }));

    const exporter = yield* SnapshotExport;
    const snapshot = yield* exporter.build(profile, { now: "2026-10-19T12:00:00+00:00", frozenMarketPath: null });
    assert(snapshot.schema_version === 1);
    const marker = "Made with an older profile or prompt. ";
    assert.equal(snapshot.jobs.length, 5);
    assert(snapshot.jobs.every((job) => job.assessment.reason.startsWith(marker)));

    const withoutMarker = { ...snapshot, jobs: snapshot.jobs.map((job) => ({ ...job,
      assessment: { ...job.assessment, reason: job.assessment.reason.slice(marker.length) },
    })) };

    yield* compareText("tests/oracle/resume-run/snapshot/snapshot-v1.json", new TextDecoder().decode(snapshotJsonBytes(withoutMarker)));
    assert.deepEqual(yield* fs.readFile(selection.path), original);

    for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(yield* fs.exists(selection.path + suffix), false);

    // Frozen v1 history must survive a same-week recording that replaces the
    // frozen point in the deliberately merged v2 history.
    const now = "2026-10-19T12:00:00+00:00";
    const inputs = yield* readSnapshotMarketInputs(profile, now, null);
    assert(inputs.ads.length > 1);
    const frozenPath = join(root, "data/market.sqlite3");
    const frozen = yield* acquireStore(frozenPath, "create");
    yield* initializeMarketAggregates(frozen);
    yield* frozen.withTransaction(replaceSnapshot(frozen, "week-2026-W43", inputs.ads.slice(0, 1), inputs.taxonomy, {
      source: "Synthetic frozen weekly backfill", created_at: now, basis: "titles", period_start: "2026-10-19", period_end: "2026-10-25",
    }));
    const frozenBefore = yield* fs.readFile(frozenPath);
    const beforeRecording = yield* exporter.build(profile, { now, frozenMarketPath: frozenPath });
    const market = yield* Market;
    const recorded = yield* market.recordMarketSnapshot(profile, selected.settings, { now });
    assert.equal(recorded.status, "recorded");
    const afterRecording = yield* exporter.build(profile, { now, frozenMarketPath: frozenPath });
    assert.deepEqual(snapshotJsonBytes(afterRecording), snapshotJsonBytes(beforeRecording));
    const frozenInputs = yield* readSnapshotMarketInputs(profile, now, frozenPath);
    assert.equal(frozenInputs.snapshots.length, 1);
    assert.equal(frozenInputs.snapshots[0]?.info.ad_count, 1);
    const v2 = yield* Schema.decodeUnknown(Schema.typeSchema(SnapshotV2))(yield* exporter.build(profile, { now, frozenMarketPath: frozenPath, version: 2 }));
    const overlap = v2.market_history?.filter((point) => point.label === "week-2026-W43");
    assert.equal(overlap?.length, 1);
    assert.equal(overlap?.[0]?.origin, "recorded");
    assert.equal(overlap?.[0]?.ad_count, inputs.ads.length);
    assert.equal(v2.market_history?.some((point) => point.basis === "titles+text" && point.origin === "recorded"), true);

    yield* fs.writeFileString(recordingPath(profile), "Synthetic invalid recording store");
    assert.deepEqual(snapshotJsonBytes(yield* exporter.build(profile, { now, frozenMarketPath: frozenPath })), snapshotJsonBytes(beforeRecording));
    assert(Either.isLeft(yield* Effect.either(exporter.build(profile, { now, frozenMarketPath: frozenPath, version: 2 }))));
    assert.deepEqual(yield* fs.readFile(frozenPath), frozenBefore);

    // Modify only this owned synthetic copy after the unchanged-reader proof.
    const writer = yield* openJudgeDatabase({ ...selection, readonly: false, require_existing: true });
    const results = yield* writer.sql<Record<string, string | number | null>>`SELECT * FROM stage_results WHERE stage='full_review' ORDER BY listing_id`;
    const first = results[0];
    assert(first);
    const identity = yield* Schema.decodeUnknown(Schema.Struct({ attempt_id: Schema.String, listing_id: Schema.String }))(first);
    const attempts = yield* writer.sql<Record<string, string | number | null>>`SELECT * FROM stage_attempts WHERE attempt_id=${identity.attempt_id}`;
    const attempt = attempts[0];
    assert(attempt);
    const newAttempt = { ...attempt, attempt_id: "00000000-0000-4000-8000-00000000b601", attempt_number: 99 };
    const insert = (table: string, row: Readonly<Record<string, string | number | null>>) => writer.sql.unsafe(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
    yield* insert("stage_attempts", newAttempt);
    const earliest = "2026-10-18T23:00:00+00:00";
    yield* insert("stage_results", { ...first, result_id: "00000000-0000-4000-8000-00000000b602", attempt_id: newAttempt.attempt_id, recorded_at: earliest });
    yield* writer.sql`CREATE TABLE historical_review_results (result_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,listing_id TEXT NOT NULL,source_version TEXT NOT NULL,input_fingerprint TEXT NOT NULL,payload_json TEXT NOT NULL,imported_at TEXT NOT NULL,FOREIGN KEY(profile_id) REFERENCES personal_state_profile(profile_id))`;
    const imported = "00000000-0000-4000-8000-00000000b603";
    yield* writer.sql`INSERT INTO historical_review_results VALUES (${imported},'invented',${imported},'2026-10-19T10:00:00+00:00','synthetic','{}',${earliest})`;
    const titleRows = yield* writer.sql<Record<string, string | number | null>>`SELECT * FROM stage_results WHERE stage='title_screen' LIMIT 1`;
    const titleRow = titleRows[0];
    assert(titleRow);
    const titleOnlyId = "00000000-0000-4000-8000-00000000b604";
    const titleValue = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })))(titleRow["result_json"]);
    yield* insert("stage_results", { ...titleRow, listing_id: titleOnlyId, result_id: "00000000-0000-4000-8000-00000000b605", result_json: JSON.stringify({ ...titleValue, id: titleOnlyId }) });
    const found = yield* readFullReviewFirstFound(writer);
    assert.equal(found.find((row) => row.listing_id === identity.listing_id)?.first_found_at, earliest);
    assert.equal(found.some((row) => row.listing_id === imported), false);
    assert.equal(found.some((row) => row.listing_id === titleOnlyId), false);
    assert.equal(found.length, results.length);
    yield* writer.sql`ALTER TABLE stage_results RENAME TO unavailable_stage_results`;
    const failed = yield* Effect.either(readFullReviewFirstFound(writer));
    assert(Either.isLeft(failed));
    assert.equal(failed.left._tag, "JudgeStateError");

  }));
})).pipe(Effect.provide(Layer.mergeAll(AppLive, converter))));
