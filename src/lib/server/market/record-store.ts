import { Effect } from "effect";
import type { MarketAd, MarketBasis } from "../../contracts/market.ts";
import type { SqliteResource } from "../shared/sqlite-resource.ts";
import { countSnapshot, uniqueAds, unknownTitleWordCounts } from "./core.ts";
import type { Taxonomy } from "./taxonomy.ts";
import { MarketError } from "./errors.ts";

// Retained aggregate layout. Only an explicit new writer initializes it; readers never do.
export const aggregateStatements = [
  `CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    period_start TEXT,
    period_end TEXT,
    source TEXT NOT NULL,
    sampled INTEGER NOT NULL,
    ad_count INTEGER NOT NULL,
    taxonomy_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    basis TEXT NOT NULL DEFAULT 'titles' CHECK (basis IN ('titles', 'titles+text'))
)`,
  `CREATE TABLE IF NOT EXISTS counts (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    kind TEXT NOT NULL CHECK (kind IN ('family', 'term')),
    key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, kind, key)
)`,
  `CREATE TABLE IF NOT EXISTS tech_term_counts (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, key)
)`,
  `CREATE TABLE IF NOT EXISTS unknown_title_word_snapshots (
    snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id),
    complete INTEGER NOT NULL CHECK (complete IN (0, 1))
)`,
  `CREATE TABLE IF NOT EXISTS unknown_title_word_counts (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    word TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, word)
)`,
];

export const initializeMarketAggregates = (sql: SqliteResource) => Effect.forEach(aggregateStatements, (statement) => sql.unsafe(statement), { discard: true });

export const metadataStatement = `CREATE TABLE market_snapshot_meta (
    snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id),
    profile_id TEXT NOT NULL,
    series TEXT NOT NULL CHECK (series IN ('titles','detailed')),
    capture_week TEXT NOT NULL,
    timezone TEXT NOT NULL,
    membership TEXT NOT NULL,
    classifier_engine TEXT NOT NULL,
    filter_fingerprint TEXT,
    population INTEGER NOT NULL,
    text_coverage INTEGER NOT NULL,
    occupation_coverage INTEGER NOT NULL
)`;

export interface RecordSnapshotOptions {
  readonly source: string;
  readonly created_at: string;
  readonly basis?: MarketBasis;
  readonly sampled?: boolean;
  readonly period_start?: string | null;
  readonly period_end?: string | null;
}

// Low-level retained record semantics. The caller owns the selected writer and enclosing transaction.
export const replaceSnapshot = (sql: SqliteResource, label: string, ads: readonly MarketAd[], tax: Taxonomy, options: RecordSnapshotOptions) => Effect.gen(function* () {
  const selectedLabel = label.trim();

  if (!selectedLabel) return yield* new MarketError({ message: "Snapshot label is required" });

  if (!tax.enabled) return yield* new MarketError({ message: "Market view is turned off for this installation" });
  const rows = uniqueAds(ads);
  const counts = countSnapshot(rows, tax);
  const words = unknownTitleWordCounts(rows, tax);
  const dates = rows.map((ad) => ad.published.slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const basis = options.basis ?? (rows.some((ad) => ad.text || ad.occupations) ? "titles+text" : "titles");
  const old = yield* sql<{ id: number }>`SELECT id FROM snapshots WHERE label=${selectedLabel}`;

  if (old[0]) {
    const id = old[0].id;
    yield* sql`DELETE FROM counts WHERE snapshot_id=${id}`;
    yield* sql`DELETE FROM tech_term_counts WHERE snapshot_id=${id}`;
    yield* sql`DELETE FROM unknown_title_word_counts WHERE snapshot_id=${id}`;
    yield* sql`DELETE FROM unknown_title_word_snapshots WHERE snapshot_id=${id}`;
    // The new store's caller deletes metadata before calling this retained primitive.
    yield* sql`DELETE FROM snapshots WHERE id=${id}`;
  }

  yield* sql`INSERT INTO snapshots (label,period_start,period_end,source,sampled,ad_count,taxonomy_version,created_at,basis) VALUES (${selectedLabel},${options.period_start || dates[0] || null},${options.period_end || dates.at(-1) || null},${options.source},${options.sampled ? 1 : 0},${counts.ad_count},${tax.version},${options.created_at},${basis})`;
  const inserted = yield* sql<{ id: number }>`SELECT id FROM snapshots WHERE label=${selectedLabel}`;
  const id = inserted[0]?.id;

  if (id === undefined) return yield* new MarketError({ message: "Snapshot was not stored" });

  for (const [key, count] of Object.entries(counts.families)) yield* sql`INSERT INTO counts (snapshot_id,kind,key,count) VALUES (${id},'family',${key},${count})`;

  for (const [key, count] of Object.entries(counts.terms)) yield* sql`INSERT INTO counts (snapshot_id,kind,key,count) VALUES (${id},'term',${key},${count})`;

  for (const [key, count] of Object.entries(counts.tech_terms)) yield* sql`INSERT INTO tech_term_counts (snapshot_id,key,count) VALUES (${id},${key},${count})`;
  yield* sql`INSERT INTO unknown_title_word_snapshots (snapshot_id,complete) VALUES (${id},${Object.keys(words).length < 500 ? 1 : 0})`;

  for (const [word, count] of Object.entries(words)) yield* sql`INSERT INTO unknown_title_word_counts (snapshot_id,word,count) VALUES (${id},${word},${count})`;

  return id;
});
