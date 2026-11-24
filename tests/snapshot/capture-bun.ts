import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer } from "effect";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type { ProfileBundle } from "../../src/lib/contracts/profile.ts";
import { decodeSnapshotBytes, decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import { PhoneShortlistLive, SavedReviewResource } from "../../src/lib/server/select/phone-shortlist.ts";
import { SnapshotCapture, SnapshotCaptureLive } from "../../src/lib/server/snapshot/capture.ts";
import { exportLatestSnapshot } from "../../src/lib/server/snapshot/export-latest.ts";
import { SnapshotJsonFile, SnapshotJsonFileLive } from "../../src/lib/server/snapshot/json-file.ts";
import { snapshotV2 } from "../../src/lib/server/snapshot/market-history.ts";
import { SnapshotPathsLive } from "../../src/lib/server/snapshot/paths.ts";
import { SnapshotExport, SnapshotExportLive, SnapshotFacts } from "../../src/lib/server/snapshot/service.ts";
import { Market } from "../../src/lib/server/market/service.ts";
import { loadTaxonomy } from "../../src/lib/server/market/taxonomy.ts";
import { SnapshotStore, SnapshotStoreLive } from "../../src/lib/server/snapshot/store.ts";

const snapshot = Either.getOrThrow(decodeSnapshotBytes(readFileSync("contracts/fixtures/snapshot.example.json")));
const resource = Layer.succeed(SavedReviewResource, { read: Effect.succeed({ verified: true, listingIds: [], candidates: [], firstFound: {} }) });
const paths = SnapshotPathsLive.pipe(Layer.provide(BunContext.layer));
const files = SnapshotJsonFileLive.pipe(Layer.provide(paths), Layer.provide(BunContext.layer));
const exporter = Layer.succeed(SnapshotExport, { build: (_profile, options) => Effect.succeed(options?.version === 2 ? Either.getOrThrow(snapshotV2(snapshot, null)) : snapshot) });
const facts = Layer.succeed(SnapshotFacts, { load: () => Effect.dieMessage("No-digest capture must not read shortlist facts") });
const dependencies = Layer.mergeAll(BunContext.layer, paths, files, SnapshotStoreLive, resource, exporter, facts, PhoneShortlistLive.pipe(Layer.provide(resource)));
const capture = SnapshotCaptureLive.pipe(Layer.provide(dependencies));

const profile = (directory: string): ProfileBundle => ({
  profile_id: "demo", paths: { profile_id: "demo", directory, profile_file: join(directory, "profile.toml"), narrative_file: join(directory, "profile.md"), preferences_file: join(directory, "preferences.toml"), source_db: join(directory, "source.sqlite3"), review_db: join(directory, "review.sqlite3"), ledger_db: join(directory, "ledger.sqlite3"), outbox_dir: join(directory, "outbox") },
  policy: { mode: "passive", max_recommendations: 120, exceptional_only: true, market_only: false, freshness_max_age: { $seconds: 86400 }, timezone: "Europe/Oslo", cadence: { kind: "weekly", anchor: null } }, default_reviewer: null, full_review_batch_size: 5,
});

const captureProof = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-capture-"));

  try {
    const output = join(directory, "dashboard-snapshot.sqlite3");
    const companion = join(directory, "unrelated.json");
    await writeFile(companion, "not a snapshot");

    const result = await Effect.runPromise(Effect.gen(function* () {
      const service = yield* SnapshotCapture;

      return yield* service.capture(profile(directory), output, { digest: { kind: "none" }, version: 2, companionJson: companion });
    }).pipe(Effect.provide(capture)));

    assert.equal(result.rowId, 1);
    assert.notEqual(result.jsonWarning, null);
    assert.equal(await readFile(companion, "utf8"), "not a snapshot");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const latest = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* SnapshotStore).latest(output); }).pipe(Effect.provide(SnapshotStoreLive)));
    assert.equal(latest?.dashboardBundle, null);
    assert.equal(Either.getOrThrow(decodeSnapshotDocumentBytes(latest!.dashboardJson!)).schema_version, 2);
    const freshJson = join(directory, "dashboard-snapshot.json");

    const second = await Effect.runPromise(Effect.gen(function* () {
      const service = yield* SnapshotCapture;

      return yield* service.capture(profile(directory), output, { digest: { kind: "none" }, companionJson: freshJson });
    }).pipe(Effect.provide(capture)));

    assert.equal(second.document.schema_version, 1);
    assert.equal(second.jsonWarning, null);
    const local = await Effect.runPromise(Effect.flatMap(SnapshotJsonFile, (file) => file.read(freshJson)).pipe(Effect.provide(files)));
    assert.equal(local.schema_version, 1);
    assert.equal((await stat(freshJson)).mode & 0o777, 0o600);
    const exported = join(directory, "one-row.sqlite3");
    await Effect.runPromise(exportLatestSnapshot(output, exported).pipe(Effect.provide(dependencies)));
    assert.equal((await stat(exported)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
};

await captureProof();

// Disabled taxonomy must not read Market history through the new v2 path.
await Effect.runPromise(Effect.gen(function* () {
  const taxonomy = yield* loadTaxonomy();
  assert.equal(taxonomy.enabled, false);
  const now = "2026-01-15T08:00:00+00:00";

  const disabledFacts = Layer.succeed(SnapshotFacts, { load: () => Effect.succeed({
    now, profile: { id: "demo", mode: "passive" as const }, funnel: { verified: true, listingIds: new Set<string>() },
    judge: { checked_at: now, eligible_count: 0, pending_count: 0, screened_out_count: 0, failed_count: 0, ranked: [], closed: [], firstFound: {} },
    market: { taxonomy, snapshots: [], ads: [], salaries: [] },
  }) });

  const noMarket = Layer.succeed(Market, {
    readHistory: () => Effect.dieMessage("Disabled Market must not read history"),
    recordMarketSnapshot: () => Effect.dieMessage("Snapshot must not record Market"),
    salary: () => Effect.dieMessage("Unused Market salary adapter"), salaryLabels: () => Effect.dieMessage("Unused Market salary labels"),
  });

  const built = yield* Effect.flatMap(SnapshotExport, (service) => service.build(profile("/invented/local_only/profiles/demo"), { now, version: 2 })).pipe(
    Effect.provide(SnapshotExportLive.pipe(Layer.provide(disabledFacts), Layer.provide(noMarket))),
  );

  assert.equal(built.schema_version, 2);
  assert("market_history" in built && built.market_history === null);
}).pipe(Effect.provide(BunContext.layer)));
