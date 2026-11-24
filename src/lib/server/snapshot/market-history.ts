import { Either, Schema } from "effect";
import type { MarketHistoryEntry } from "../../contracts/market.ts";
import { SnapshotMarketPoint, SnapshotV2, type Snapshot } from "../../contracts/snapshot.ts";

// Deliberate projection: no database IDs, source paths or raw listing data cross the wire.
export const snapshotMarketHistory = (entries: readonly MarketHistoryEntry[]) => Schema.decodeUnknownEither(
  Schema.Array(Schema.typeSchema(SnapshotMarketPoint)), { onExcessProperty: "error" },
)(entries.map((entry) => ({
  label: entry.info.label, basis: entry.info.basis, period_start: entry.info.period_start,
  period_end: entry.info.period_end, sampled: entry.info.sampled, ad_count: entry.info.ad_count,
  taxonomy_version: entry.info.taxonomy_version, captured_at: entry.info.created_at,
  counts: entry.counts, origin: entry.origin, metadata: entry.metadata,
})));

// Existing callers keep v1. The dashboard caller must explicitly select this v2 producer.
export const snapshotV2 = (snapshot: Snapshot, history: readonly MarketHistoryEntry[] | null) => {
  const points = history === null ? Either.right(null) : snapshotMarketHistory(history);

  return Either.flatMap(points, (market_history) => Schema.decodeUnknownEither(Schema.typeSchema(SnapshotV2), { onExcessProperty: "error" })({
    ...snapshot, schema_version: 2, market_history,
  }));
};
