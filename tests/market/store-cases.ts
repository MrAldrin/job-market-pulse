import assert from "node:assert/strict";
import { join } from "node:path";
import { BunContext } from "@effect/platform-bun";
import { FileSystem } from "@effect/platform";
import { Cause, Effect, Either, Exit, Fiber, Layer } from "effect";
import type { ProfileBundle } from "../../src/lib/contracts/profile.ts";
import { GeographyAreasLive } from "../../src/lib/server/filter/geography-service.ts";
import { FilterSourcePackageResources } from "../../src/lib/server/filter/service.ts";
import { Market, MarketLive, recordingPath } from "../../src/lib/server/market/service.ts";
import { readHistory, readHistoryFile } from "../../src/lib/server/market/history-store.ts";
import { initializeMarketAggregates, replaceSnapshot } from "../../src/lib/server/market/record-store.ts";
import { loadTaxonomy } from "../../src/lib/server/market/taxonomy.ts";
import { readSalaryFacts, readMarketSource } from "../../src/lib/server/source/market-readers.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { filterSettings } from "../filter/fixtures.ts";
import { fixtureTaxonomyText } from "./fixture-taxonomy.ts";

const now = "2026-10-19T12:00:00+00:00";
const version = "2026-10-19T10:00:00+00:00";
const uid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const profile = (root: string): ProfileBundle => {
  const directory = join(root, "local_only", "profiles", "invented");

  return { profile_id: "invented", paths: { profile_id: "invented", directory, profile_file: join(directory, "profile.toml"), narrative_file: join(directory, "profile.md"), preferences_file: join(directory, "preferences.toml"), source_db: join(root, "data", "source.sqlite3"), review_db: join(directory, "review.sqlite3"), ledger_db: join(directory, "ledger.sqlite3"), outbox_dir: join(directory, "outbox") }, policy: { mode: "passive", max_recommendations: 120, exceptional_only: true, market_only: false, freshness_max_age: { $seconds: 86400 }, timezone: "Europe/Oslo", cadence: { kind: "weekly", anchor: null } }, default_reviewer: null, full_review_batch_size: 1 };
};

const base = filterSettings();
const geography = { radius_km: 100, origin_latitude: 63.43, origin_longitude: 10.39, origin_source: "synthetic" };
const settings = { ...base, filters: { ...base.filters, geography }, preferences: { ...base.preferences, ...geography } };
const live = MarketLive.pipe(Layer.provide(GeographyAreasLive), Layer.provide(FilterSourcePackageResources), Layer.provide(BunContext.layer));

const program = Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-market-" });
  const selected = profile(root);
  const market = yield* Market;
  assert.deepEqual(yield* market.recordMarketSnapshot(selected, settings), { status: "disabled" });
  assert.equal(yield* fs.exists(selected.paths.directory), false);
  yield* fs.makeDirectory(join(root, "local_only", "config"), { recursive: true });
  yield* fs.writeFileString(join(root, "local_only", "config", "market_taxonomy.toml"), yield* fixtureTaxonomyText);
  yield* fs.makeDirectory(join(root, "data"));
  const source = yield* acquireStore(selected.paths.source_db, "create");
  yield* initializeSourceStorage(source);
  yield* source`INSERT INTO state VALUES ('checked',${now}),('caught_up','1')`;

  for (const [index, location, expiry] of [[1, "Trondheim", null], [2, "Trondheim", null], [3, "Oslo", null], [4, "Trondheim", "2026-10-18T00:00:00+00:00"]] as const) {
    const id = uid(index);
    yield* source`INSERT INTO ads VALUES (${id},${version},${version},${version},'General role','Invented Works',${JSON.stringify([location])},'[]',0,${expiry},'SYNTHETIC')`;
    yield* source`INSERT INTO versions VALUES (${id},${version})`;
    yield* source`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','IT','Software','','')`;
    yield* source`INSERT INTO ad_occupation_checks VALUES (${id},${version},1)`;
  }

  const tax = yield* loadTaxonomy(root);
  const frozenPath = join(root, "data", "frozen-market.sqlite3");
  const frozen = yield* acquireStore(frozenPath, "create");
  yield* initializeMarketAggregates(frozen);
  yield* frozen.withTransaction(replaceSnapshot(frozen, "2026-09", [], tax, { source: "invented backfill", created_at: now, basis: "titles", period_start: "2026-09-01", period_end: "2026-09-30" }));
  yield* frozen.withTransaction(replaceSnapshot(frozen, "week-2026-W43", [], tax, { source: "invented old overlap", created_at: now, basis: "titles", period_start: "2026-10-19", period_end: "2026-10-25" }));
  const before = yield* fs.readFile(frozenPath);
  const sourceBefore = yield* fs.readFile(selected.paths.source_db);
  const text = { listing_id: uid(1), source_version: version, text: "We use Python, Docker and Kubernetes.", fingerprint: "a".repeat(64), byte_count: 42, provenance: null, snapshot: {}, snapshot_id: "b".repeat(64), detail_changed: version };
  const stagedPaths: string[] = [];

  const interruptBeforePublication: typeof fs.link = (from, to) => to !== recordingPath(selected) ? fs.link(from, to) : Effect.gen(function* () {
    stagedPaths.push(from);
    // The first pair is already committed and readable before publication.
    assert.equal((yield* readHistory(null, from, selected.profile_id)).length, 2);
    assert.equal(yield* fs.exists(to), false);

    return yield* Effect.interrupt;
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie);

  const withPublication = (link: typeof fs.link) => MarketLive.pipe(
    Layer.provide(GeographyAreasLive), Layer.provide(FilterSourcePackageResources),
    Layer.provide(Layer.succeed(FileSystem.FileSystem, { ...fs, link })),
  );

  const attempt = yield* Effect.flatMap(Market, (service) => service.recordMarketSnapshot(selected, settings, { now, texts: [text] })).pipe(Effect.provide(withPublication(interruptBeforePublication)), Effect.fork);
  const interrupted = yield* Fiber.await(attempt);
  assert(Exit.isFailure(interrupted) && Cause.isInterrupted(interrupted.cause));
  assert.equal(stagedPaths.length, 1);
  assert(stagedPaths[0]);
  assert.equal(yield* fs.exists(stagedPaths[0]), false);
  assert.equal(yield* fs.exists(recordingPath(selected)), false);
  const unrelated = "Invented unrelated file created while the first pair was staged";
  const concurrentPublication: typeof fs.link = (from, to) => to !== recordingPath(selected) ? fs.link(from, to) : fs.writeFileString(to, unrelated, { flag: "wx" }).pipe(Effect.zipRight(fs.link(from, to)));
  const raced = yield* Effect.flatMap(Market, (service) => service.recordMarketSnapshot(selected, settings, { now })).pipe(Effect.provide(withPublication(concurrentPublication)), Effect.either);
  assert(Either.isLeft(raced));
  assert.equal(yield* fs.readFileString(recordingPath(selected)), unrelated);
  assert(Either.isLeft(yield* market.recordMarketSnapshot(selected, settings, { now }).pipe(Effect.either)));
  assert.equal(yield* fs.readFileString(recordingPath(selected)), unrelated);
  // Remove only this fixture's unrelated file, then retry the genuine recording.
  yield* fs.remove(recordingPath(selected));
  const first = yield* market.recordMarketSnapshot(selected, settings, { now, texts: [text] });
  assert.equal(first.status, "recorded");

  if (first.status === "recorded") {
    assert.equal(first.titles.population, 3);
    assert.deepEqual([first.detailed.population, first.detailed.text_coverage, first.detailed.occupation_coverage], [2, 1, 2]);
  }

  assert.deepEqual(yield* fs.readFile(selected.paths.source_db), sourceBefore);
  const initial = yield* market.readHistory(selected, frozenPath);
  assert.equal(initial.length, 3);
  assert.equal(initial.find((entry) => entry.info.label === "week-2026-W43")?.origin, "recorded");
  assert(initial.every((entry) => entry.info.taxonomy_version === "2026.10-v5"));
  const detail = initial.find((entry) => entry.metadata?.series === "detailed");
  assert.equal(detail?.counts.families.software_development, 1);
  assert.equal(detail?.metadata?.filter_fingerprint, settings.preference_fingerprint);
  const changed = { ...settings, preference_fingerprint: "c".repeat(64) };
  yield* market.recordMarketSnapshot(selected, changed, { now: "2026-10-20T12:00:00+00:00" });
  const replaced = yield* market.readHistory(selected, frozenPath);
  assert.equal(replaced.length, 3);
  assert.equal(replaced.find((entry) => entry.metadata?.series === "detailed")?.metadata?.text_coverage, 0);
  assert.equal(replaced.find((entry) => entry.metadata?.series === "detailed")?.metadata?.filter_fingerprint, changed.preference_fingerprint);
  const writer = yield* acquireStore(recordingPath(selected), "existing");
  yield* writer.unsafe("CREATE TRIGGER reject_detail BEFORE INSERT ON snapshots WHEN NEW.label LIKE 'detail-%' BEGIN SELECT RAISE(ABORT,'invented replacement failure'); END");
  const failed = yield* market.recordMarketSnapshot(selected, settings, { now, texts: [text] }).pipe(Effect.either);
  assert(Either.isLeft(failed));
  assert.deepEqual(yield* market.readHistory(selected, frozenPath), replaced);
  yield* writer`DROP TRIGGER reject_detail`;
  yield* source`UPDATE state SET value='2026-10-26T12:00:00+00:00' WHERE key='checked'`;
  yield* market.recordMarketSnapshot(selected, settings, { now: "2026-10-26T12:00:00+00:00" });
  assert.equal((yield* market.readHistory(selected, frozenPath)).length, 5);
  assert.deepEqual(yield* fs.readFile(frozenPath), before);
  // Only the explicit fixture's later checked-state update changes Source.
  yield* source`UPDATE state SET value=${now} WHERE key='checked'`;
  assert.deepEqual(yield* readMarketSource(source, now).pipe(Effect.map((ads) => ads.map((ad) => ad.uuid))), [uid(1), uid(2), uid(3)]);
  assert.equal(sourceBefore.length, (yield* fs.readFile(selected.paths.source_db)).length);
  const staleText = yield* market.recordMarketSnapshot(selected, settings, { now, texts: [{ ...text, source_version: "2026-10-18T10:00:00+00:00" }] }).pipe(Effect.either);
  assert(Either.isLeft(staleText));
  const latest = yield* market.readHistory(selected, frozenPath);
  assert.equal(latest.length, 5);

  const missing = join(root, "missing", "history.sqlite3");
  assert.deepEqual(yield* readHistory(missing, null, "invented"), []);
  assert.equal(yield* fs.exists(join(root, "missing")), false);

  // A legacy aggregate file has no basis column and must not be migrated by a read.
  const legacyPath = join(root, "legacy.sqlite3");
  const legacy = yield* acquireStore(legacyPath, "create");
  yield* legacy.unsafe("CREATE TABLE snapshots (id INTEGER PRIMARY KEY,label TEXT,period_start TEXT,period_end TEXT,source TEXT,sampled INTEGER,ad_count INTEGER,taxonomy_version TEXT,created_at TEXT)");
  yield* legacy.unsafe("CREATE TABLE counts(snapshot_id INTEGER,kind TEXT,key TEXT,count INTEGER)");
  yield* legacy`INSERT INTO snapshots VALUES (1,'2026-09',NULL,NULL,'invented',0,0,'old',${now})`;
  const legacyBefore = yield* fs.readFile(legacyPath);
  assert.equal((yield* readHistoryFile(legacyPath))[0]?.info.basis, "titles");
  assert.deepEqual(yield* fs.readFile(legacyPath), legacyBefore);

  // Retained closed salary facts and optional legacy columns stay readable.
  const salaryPath = join(root, "salary.sqlite3");
  const salary = yield* acquireStore(salaryPath, "create");
  yield* salary.unsafe("CREATE TABLE ad_salaries(uuid TEXT,detail_changed TEXT,form TEXT,min_nok REAL,max_nok REAL,period TEXT,sko_code TEXT,ltr_min INTEGER)");
  yield* salary`INSERT INTO ad_salaries VALUES ('closed',${version},'single',650000,650000,'year',NULL,NULL)`;
  const oldSalary = yield* readSalaryFacts(salaryPath);
  assert.equal(oldSalary.salaries[0]?.period_inferred, false);
  assert.equal(oldSalary.salaries[0]?.ltr_max, null);
  assert.equal((yield* market.salary(salaryPath, new Set(["closed"]))).ads[0]?.yearly_midpoint, 650000);
  assert.equal((yield* market.salaryLabels(salaryPath, new Map([["closed", version]]))).closed, "Lønn: 650 000 kr/år");
  assert.equal((yield* market.salaryLabels(salaryPath, new Map([["closed", now]]))).closed, "Lønn ukjent");

  // Disabled settings return before touching a missing Source or recording path.
  const disabled = profile(join(root, "disabled"));
  const override = join(root, "disabled", "local_only", "config");
  yield* fs.makeDirectory(override, { recursive: true });
  yield* fs.writeFileString(join(override, "market_taxonomy.toml"), "[settings]\nenabled = false\n");
  assert.deepEqual(yield* market.recordMarketSnapshot(disabled, settings), { status: "disabled" });
  assert.equal(yield* fs.exists(disabled.paths.directory), false);
  console.log("Market store: passed");
})).pipe(Effect.provide(live), Effect.provide(BunContext.layer));

await Effect.runPromise(program);
