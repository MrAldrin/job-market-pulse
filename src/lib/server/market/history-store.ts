import { FileSystem } from "@effect/platform";
import { Reactivity } from "@effect/experimental";
import { Effect, Schema } from "effect";
import { isAbsolute } from "node:path";
import { MarketCaptureMetadata, type MarketHistoryEntry, SavedMarketSnapshot, SnapshotInfo } from "../../contracts/market.ts";
import { acquireSqliteResource } from "../shared/sqlite-resource.ts";
import type { JsonInput } from "../shared/json-input.ts";
import { MarketError, marketOpenFailure } from "./errors.ts";

export const marketDecode = <A, I>(schema: Schema.Schema<A, I>, value: JsonInput) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(value).pipe(
  Effect.mapError(() => new MarketError({ message: "Invalid saved market data" })),
);

// Each explicit operation uses the canonical selected-resource facade, never a default database.
export const acquireMarketReader = (path: string) => Effect.gen(function* () {
  if (!isAbsolute(path)) return yield* new MarketError({ message: "Market database path must be explicit and absolute" });
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.mapError(() => new MarketError({ message: "Market database is unavailable" })));

  if (info.type !== "File") return yield* new MarketError({ message: "Market database is unavailable" });

  const sql = yield* acquireSqliteResource({ filename: path, readonly: true, readwrite: false, create: false }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.catchAllDefect(marketOpenFailure),
  );

  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA query_only = ON`;

  return sql;
});

export type MarketSql = Effect.Effect.Success<ReturnType<typeof acquireMarketReader>>;

const tableNames = (sql: MarketSql) => sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`.pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));
const CountRow = Schema.Struct({ kind: Schema.Literal("family", "term"), key: Schema.String, count: Schema.Int.pipe(Schema.nonNegative()) });
const KeyCount = Schema.Struct({ key: Schema.String, count: Schema.Int.pipe(Schema.nonNegative()) });
const WordCount = Schema.Struct({ word: Schema.String, count: Schema.Int.pipe(Schema.nonNegative()) });

export const readSavedSnapshots = (sql: MarketSql) => Effect.gen(function* () {
  const tables = yield* tableNames(sql);

  if (!tables.has("snapshots")) return yield* new MarketError({ message: "Selected file is not a saved Market store" });
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(snapshots)`;
  const basis = columns.some((column) => column.name === "basis") ? "basis" : "CASE WHEN label LIKE 'current-%' THEN 'titles+text' ELSE 'titles' END AS basis";
  const rows = yield* sql.unsafe<Record<string, string | number | null>>(`SELECT id,label,period_start,period_end,source,sampled,ad_count,taxonomy_version,created_at,${basis} FROM snapshots ORDER BY COALESCE(period_start,label),label`);
  const snapshots: SavedMarketSnapshot[] = [];

  for (const row of rows) {
    const info = yield* marketDecode(SnapshotInfo, { ...row, sampled: row.sampled === 1 });
    const counted = yield* marketDecode(Schema.Array(CountRow), yield* sql<Schema.Schema.Type<typeof CountRow>>`SELECT kind,key,count FROM counts WHERE snapshot_id=${info.id}`);
    const tech = tables.has("tech_term_counts") ? yield* marketDecode(Schema.Array(KeyCount), yield* sql<Schema.Schema.Type<typeof KeyCount>>`SELECT key,count FROM tech_term_counts WHERE snapshot_id=${info.id}`) : [];
    const words = tables.has("unknown_title_word_counts") ? yield* marketDecode(Schema.Array(WordCount), yield* sql<Schema.Schema.Type<typeof WordCount>>`SELECT word,count FROM unknown_title_word_counts WHERE snapshot_id=${info.id}`) : null;
    const complete = tables.has("unknown_title_word_snapshots") ? yield* sql<{ complete: number }>`SELECT complete FROM unknown_title_word_snapshots WHERE snapshot_id=${info.id}` : [];
    snapshots.push(yield* marketDecode(SavedMarketSnapshot, {
      info,
      counts: {
        families: Object.fromEntries(counted.filter((item) => item.kind === "family").map((item) => [item.key, item.count])),
        terms: Object.fromEntries(counted.filter((item) => item.kind === "term").map((item) => [item.key, item.count])),
        tech_terms: Object.fromEntries(tech.map((item) => [item.key, item.count])),
      },
      unknown_words: words === null ? null : Object.fromEntries(words.map((item) => [item.word, item.count])),
      words_complete: complete[0] ? complete[0].complete === 1 : null,
    }));
  }

  return snapshots;
});

// Missing optional history stays absent. Existing invalid stores fail; reads never initialize or migrate.
const readOptionalFile = <A, E>(path: string | null, read: (sql: MarketSql) => Effect.Effect<readonly A[], E>) => Effect.scoped(Effect.gen(function* () {
  if (path === null) return [];

  if (!isAbsolute(path)) return yield* new MarketError({ message: "Market database path must be explicit and absolute" });
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) return [];
  const sql = yield* acquireMarketReader(path);

  return yield* sql.readSnapshot(read(sql));
})).pipe(Effect.mapError(() => new MarketError({ message: "Cannot read saved market aggregates" })));

export const readHistoryFile = (path: string | null) => readOptionalFile(path, readSavedSnapshots);

export const readHistory = (frozenPath: string | null, recordedPath: string | null, profileId: string) => Effect.gen(function* () {
  const frozen = (yield* readHistoryFile(frozenPath)).map((entry): MarketHistoryEntry => ({ ...entry, origin: "frozen_history", metadata: null }));

  const recorded = yield* readOptionalFile(recordedPath, (sql) => Effect.gen(function* () {
    const snapshots = yield* readSavedSnapshots(sql);
    const rows = yield* sql<Record<string, string | number | null>>`SELECT snapshot_id,profile_id,series,capture_week,timezone,membership,classifier_engine,filter_fingerprint,population,text_coverage,occupation_coverage FROM market_snapshot_meta`;
    const entries: MarketHistoryEntry[] = [];

    for (const snapshot of snapshots) {
      const raw = rows.find((row) => row.snapshot_id === snapshot.info.id);

      if (!raw) return yield* new MarketError({ message: "Market recording metadata is missing" });
      const { snapshot_id: _id, ...fields } = raw;
      const metadata = yield* marketDecode(MarketCaptureMetadata, fields);
      const expectedLabel = metadata.series === "titles" ? metadata.capture_week : `detail-${metadata.capture_week}`;

      if (metadata.profile_id !== profileId || expectedLabel !== snapshot.info.label || metadata.population !== snapshot.info.ad_count || metadata.text_coverage > metadata.population || metadata.occupation_coverage > metadata.population || snapshot.info.basis !== (metadata.series === "titles" ? "titles" : "titles+text")) return yield* new MarketError({ message: "Market recording metadata does not match its aggregates" });
      entries.push({ ...snapshot, origin: "recorded", metadata });
    }

    return entries;
  }));

  const combined = new Map<string, MarketHistoryEntry>();

  for (const entry of [...frozen, ...recorded]) combined.set(`${entry.info.basis}/${entry.info.label}`, entry);

  return [...combined.values()].sort((a, b) => (a.info.period_start ?? a.info.label).localeCompare(b.info.period_start ?? b.info.label) || a.info.label.localeCompare(b.info.label));
});
