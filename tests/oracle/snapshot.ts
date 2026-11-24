import { FileSystem } from "@effect/platform";
import { Effect, Predicate, Schema } from "effect";
import { join } from "node:path";
import { MarketAd } from "../../src/lib/contracts/market.ts";
import { Snapshot } from "../../src/lib/contracts/snapshot.ts";
import { integerToken } from "../../src/lib/contracts/support.ts";
import { readSavedSnapshots } from "../../src/lib/server/market/history-store.ts";
import { initializeMarketAggregates, replaceSnapshot } from "../../src/lib/server/market/record-store.ts";
import { marketAds } from "../../src/lib/server/market/service.ts";
import { fixtureTaxonomy } from "../market/fixture-taxonomy.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { snapshotJsonBytes, snapshotPrettyJson } from "../../src/lib/server/snapshot/serialization.ts";
import { buildSnapshot } from "../../src/lib/server/snapshot/core.ts";
import type { SnapshotInputs } from "../../src/lib/server/snapshot/inputs.ts";
import { readMarketSource, readSalarySource } from "../../src/lib/server/source/market-readers.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { compareText } from "./compare.ts";
import { withReplayedSource, type SourceBundle } from "./source.ts";

const snapshotBundles: readonly SourceBundle[] = ["basic-run", "changed-removed", "market-history", "resume-run", "duplicate-alert", "viewer-api"];

// These are test-only projections of frozen upstream boundaries, not Judge wire
// contracts. No snapshot expected output is read while constructing these inputs.
const RecordedCandidate = Schema.Struct({
  listing_id: Schema.String, source_version: Schema.String, lifecycle_status: Schema.String,
  title: Schema.String, employer: Schema.String, locations: Schema.Array(Schema.String), url: Schema.String,
  expires_at: Schema.NullOr(Schema.String), application_due: Schema.NullOr(Schema.String),
  full_review_result_id: Schema.NullOr(Schema.String),
  full_review: Schema.NullOr(Schema.Struct({
    fit: Schema.String, reason: Schema.String, evidence: Schema.Array(Schema.String),
    uncertainties: Schema.Array(Schema.String), hard_constraints: Schema.String, ad_text_reviewed: Schema.Boolean,
  })),
});

const RecordedJudge = Schema.Struct({
  checked_at: Schema.String, eligible_count: integerToken, pending_count: integerToken,
  screened_out_count: integerToken, failed_count: integerToken,
  ranked: Schema.Array(RecordedCandidate), closed: Schema.Array(RecordedCandidate),
});

const RecordedStore = Schema.Struct({ tables: Schema.Struct({ stage_results: Schema.Struct({
  columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
}) }) });

const RecordedManifest = Schema.Struct({ checked_at: Schema.String, eligible_count: integerToken, candidates: Schema.Array(Schema.Unknown) });
const RecordedProfile = Schema.Struct({ profile_id: Schema.String, policy: Schema.Struct({ mode: Schema.Literal("passive", "active") }) });

const HistoryInput = Schema.Struct({
  backfill: Schema.Array(Schema.Struct({ label: Schema.String, period_start: Schema.String, period_end: Schema.String, ads: Schema.Array(MarketAd) })),
  run_labels: Schema.Array(Schema.String),
});

const readRecorded = <A, I>(path: string, schema: Schema.Schema<A, I>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(path).pipe(Effect.flatMap(parseJsonInput));

  return yield* Schema.decodeUnknown(schema)(raw);
});

const judgeInputs = (bundle: SourceBundle) => Effect.gen(function* () {
  const root = `tests/oracle/${bundle}`;

  if (bundle === "changed-removed" || bundle === "market-history") {
    // The recorder captures an absent Judge store for these two bundles. The
    // frozen empty-state rule takes pending records and eligible count from the
    // submission manifest, not from the exported snapshot.
    yield* readRecorded(`${root}/judge/before-store.json`, Schema.Struct({ present: Schema.Literal(false) }));
    const run = bundle === "changed-removed" ? 2 : 1;
    const manifest = yield* readRecorded(`${root}/filter/run-${run}.json`, RecordedManifest);

    return { funnel: { verified: true, listingIds: new Set<string>() }, judge: {
      checked_at: manifest.checked_at, eligible_count: manifest.eligible_count,
      pending_count: manifest.candidates.length, screened_out_count: 0, failed_count: 0,
      ranked: [], closed: [], firstFound: {},
    } };
  }

  const current = yield* readRecorded(`${root}/judge/current-snapshot.json`, RecordedJudge);
  const store = yield* readRecorded(`${root}/judge/review-store.json`, RecordedStore);
  const { columns, rows } = store.tables.stage_results;
  const stage = columns.indexOf("stage"), listing = columns.indexOf("listing_id"), recorded = columns.indexOf("recorded_at");

  if (stage < 0 || listing < 0 || recorded < 0) return yield* Effect.dieMessage("Frozen Judge results lack funnel/first-found columns");
  const firstFound: Record<string, string> = {};

  for (const row of rows) {
    if (row[stage] !== "full_review") continue;
    const id = row[listing], stamp = row[recorded];

    if (!Predicate.isString(id) || !Predicate.isString(stamp)) return yield* Effect.dieMessage("Invalid frozen full-review identity/date");

    if (firstFound[id] === undefined || stamp < firstFound[id]) firstFound[id] = stamp;
  }

  // The reviewed fixtures have no historical imports, source changes after
  // review, or expiry reconciliation. Their recorded current ranking therefore
  // supplies the saved display values used by the frozen dashboard projection.
  return { judge: { ...current, firstFound }, funnel: { verified: true, listingIds: new Set(Object.keys(firstFound)) } };
});

const snapshotText = (value: Schema.Schema.Type<typeof Snapshot>): string => new TextDecoder().decode(snapshotJsonBytes(value));

const compareSnapshot = (bundle: SourceBundle) => Effect.gen(function* () {
  const profile = yield* readRecorded(`tests/oracle/${bundle}/profile/bundle.json`, RecordedProfile);
  const fixture = yield* readRecorded(`tests/fixtures/port-oracle/${bundle}/manifest.json`, Schema.Struct({ clock: Schema.String }));
  const saved = yield* judgeInputs(bundle);
  const path = `tests/oracle/${bundle}/snapshot/snapshot-v1.json`;

  yield* withReplayedSource(bundle, (source) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const taxonomy = yield* fixtureTaxonomy;
    const ads = marketAds(yield* readMarketSource(source, fixture.clock));
    const { salaries } = yield* readSalarySource(source);
    let snapshots: SnapshotInputs["market"]["snapshots"] = [];

    if (bundle === "market-history") {
      // Replay the same external history instructions as the Market producer;
      // captured aggregate rows and expected snapshot fields are never inputs.
      const history = yield* readRecorded("tests/fixtures/port-oracle/market-history/inputs/history.json", HistoryInput);
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-snapshot-market-oracle-" });
      const sql = yield* acquireStore(join(directory, "market.sqlite3"), "create");
      yield* initializeMarketAggregates(sql);

      for (const entry of history.backfill) {
        yield* sql.withTransaction(replaceSnapshot(sql, entry.label, entry.ads, taxonomy, {
          source: "invented backfill", created_at: fixture.clock, basis: "titles",
          period_start: entry.period_start, period_end: entry.period_end,
        }));
      }

      for (const label of history.run_labels) {
        yield* sql.withTransaction(replaceSnapshot(sql, label, ads, taxonomy, { source: "invented explicit recording", created_at: fixture.clock }));
      }

      snapshots = yield* readSavedSnapshots(sql);
    }

    const document = yield* buildSnapshot({
      now: fixture.clock, profile: { id: profile.profile_id, mode: profile.policy.mode }, ...saved,
      market: { snapshots, taxonomy, ads, salaries },
    });

    if (bundle === "basic-run") yield* compareText(`${path.slice(0, path.lastIndexOf("/"))}/cli-export.json`, snapshotPrettyJson(document));

    yield* compareText(path, snapshotText(document));
  }));

});

export const compareSnapshotBoundaries = Effect.forEach(snapshotBundles, compareSnapshot, { discard: true });
