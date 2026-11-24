import { Schema } from "effect";

export const MarketAd = Schema.Struct({
  uuid: Schema.String,
  published: Schema.String,
  title: Schema.String,
  employer: Schema.String,
  municipality: Schema.String,
  text: Schema.String,
  occupations: Schema.String,
});

export type MarketAd = typeof MarketAd.Type;

const countRecord = Schema.Record({ key: Schema.String, value: Schema.Int.pipe(Schema.nonNegative()) });
const counts = Schema.declare<typeof countRecord.Type>(Schema.is(countRecord));

export const LoadedCounts = Schema.Struct({ families: counts, terms: counts, tech_terms: counts });

export type LoadedCounts = typeof LoadedCounts.Type;

export const SnapshotCounts = Schema.Struct({ ad_count: Schema.Int.pipe(Schema.nonNegative()), ...LoadedCounts.fields });

export type SnapshotCounts = typeof SnapshotCounts.Type;

export const MarketBasis = Schema.Literal("titles", "titles+text");

export type MarketBasis = typeof MarketBasis.Type;

export const SnapshotInfo = Schema.Struct({
  id: Schema.Int,
  label: Schema.String,
  period_start: Schema.NullOr(Schema.String),
  period_end: Schema.NullOr(Schema.String),
  source: Schema.String,
  sampled: Schema.Boolean,
  ad_count: Schema.Int.pipe(Schema.nonNegative()),
  taxonomy_version: Schema.String,
  created_at: Schema.String,
  basis: MarketBasis,
});

export type SnapshotInfo = typeof SnapshotInfo.Type;

export const SavedMarketSnapshot = Schema.Struct({
  info: SnapshotInfo,
  counts: LoadedCounts,
  unknown_words: Schema.NullOr(counts),
  words_complete: Schema.NullOr(Schema.Boolean),
});

export type SavedMarketSnapshot = typeof SavedMarketSnapshot.Type;

export const MarketCaptureMetadata = Schema.Struct({
  profile_id: Schema.String,
  series: Schema.Literal("titles", "detailed"),
  capture_week: Schema.String,
  timezone: Schema.Literal("Europe/Oslo"),
  membership: Schema.Literal("current_unexpired_stock"),
  classifier_engine: Schema.Literal("native_js_known_ab_v1"),
  filter_fingerprint: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))),
  population: Schema.Int.pipe(Schema.nonNegative()),
  text_coverage: Schema.Int.pipe(Schema.nonNegative()),
  occupation_coverage: Schema.Int.pipe(Schema.nonNegative()),
});

export type MarketCaptureMetadata = typeof MarketCaptureMetadata.Type;

export const MarketHistoryEntry = Schema.Struct({
  ...SavedMarketSnapshot.fields,
  origin: Schema.Literal("frozen_history", "recorded"),
  metadata: Schema.NullOr(MarketCaptureMetadata),
});

export type MarketHistoryEntry = typeof MarketHistoryEntry.Type;
