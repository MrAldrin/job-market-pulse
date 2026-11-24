import { FileSystem } from "@effect/platform";
import { Reactivity } from "@effect/experimental";
import { Clock, Context, Effect, Either, Layer, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import type { MarketAd, MarketCaptureMetadata, MarketHistoryEntry } from "../../contracts/market.ts";
import type { ProfileBundle } from "../../contracts/profile.ts";
import { AdText } from "../../contracts/source-review.ts";
import { isoEpochMillis, parseIsoTime } from "../../contracts/iso-time.ts";
import type { OwnedSettings } from "../profile/service.ts";
import { GeographyAreas } from "../filter/geography-service.ts";
import { FilterResources, eligibleCandidates } from "../filter/service.ts";
import { manifestCommon, sourceFreshness } from "../filter/manifest.ts";
import { personalScreen, type ScreenContext } from "../filter/screen-context.ts";
import { readMarketCapture, readSalaryFacts } from "../source/market-readers.ts";
import { utcText } from "../source/core.ts";
import type { MarketSourceAd } from "../../contracts/source-market.ts";
import { parseJsonInput } from "../shared/json-input.ts";
import { acquireSqliteResource } from "../shared/sqlite-resource.ts";
import { titlesOnly } from "./core.ts";
import { MarketError, marketOpenFailure } from "./errors.ts";
import { readHistory } from "./history-store.ts";
import { captureWeek, periodBounds } from "./periods.ts";
import { initializeMarketAggregates, metadataStatement, replaceSnapshot } from "./record-store.ts";
import { displayLabel, readSalaryRows, salarySection } from "./salary-view.ts";
import { loadTaxonomy } from "./taxonomy.ts";

const stringList = (value: string): string[] => {
  const parsed = parseJsonInput(value);

  return Either.isRight(parsed) && Array.isArray(parsed.right) ? parsed.right.filter((item) => item !== null).map(String) : [];
};

export const marketAds = (rows: readonly MarketSourceAd[]): MarketAd[] => rows.map((row) => ({
  uuid: row.uuid, published: row.first_seen, title: row.title, employer: row.employer,
  municipality: stringList(row.locations)[0] ?? "", text: stringList(row.topics).join(" "), occupations: "",
}));

export const recordingPath = (profile: ProfileBundle): string => join(profile.paths.directory, "market-snapshots.sqlite3");
const installationRoot = (profile: ProfileBundle): string => resolve(profile.paths.directory, "../../..");

export interface MarketRecordOptions {
  readonly now?: string;
  readonly texts?: readonly (typeof AdText.Type)[];
  readonly screen?: ScreenContext;
}

export type MarketRecordResult = { readonly status: "disabled" } | {
  readonly status: "recorded";
  readonly week: string;
  readonly captured_at: string;
  readonly titles: MarketCaptureMetadata;
  readonly detailed: MarketCaptureMetadata;
};

export class Market extends Context.Tag("pulse/Market")<Market, {
  readonly recordMarketSnapshot: (profile: ProfileBundle, settings: OwnedSettings, options?: MarketRecordOptions) => Effect.Effect<MarketRecordResult, MarketError>;
  readonly readHistory: (profile: ProfileBundle, frozenPath: string | null) => Effect.Effect<readonly MarketHistoryEntry[], MarketError>;
  readonly salary: (sourcePath: string, listingIds: ReadonlySet<string>) => Effect.Effect<ReturnType<typeof salarySection>, MarketError>;
  readonly salaryLabels: (sourcePath: string, versions: ReadonlyMap<string, string>) => Effect.Effect<Readonly<Record<string, string>>, MarketError>;
}>() {}

const safe = () => new MarketError({ message: "Market operation failed" });

export const MarketLive = Layer.effect(Market, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const geography = yield* GeographyAreas;
  const resources = yield* FilterResources;

  return {
    recordMarketSnapshot: (profile, settings, options = {}) => Effect.gen(function* () {
      const tax = yield* loadTaxonomy(installationRoot(profile));

      if (!tax.enabled) return { status: "disabled" } as const;
      const common = yield* manifestCommon(profile.profile_id, settings, options.screen);
      const clock = options.now ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      const instant = parseIsoTime(clock);

      if (Option.isNone(instant) || !instant.value.aware) return yield* new MarketError({ message: "Invalid Market capture time" });
      const now = utcText(instant.value.epochMicros);
      const capture = yield* readMarketCapture(profile.paths.source_db, now);
      const manifest = { ...capture.manifest, checked_at: capture.manifest.state.checked ?? "", caught_up: capture.manifest.state.caught_up ?? "" };
      yield* sourceFreshness(manifest.checked_at, manifest.caught_up, instant.value.epochMicros, BigInt(Math.round(profile.policy.freshness_max_age.$seconds * 1_000_000)));
      const areas = yield* geography.load(resources.areaExtentsPath);
      const candidates = yield* eligibleCandidates(manifest, settings, areas, instant.value.epochMicros, personalScreen(options.screen));
      const texts = yield* Schema.decodeUnknown(Schema.Array(Schema.typeSchema(AdText)), { onExcessProperty: "error" })(options.texts ?? []).pipe(Effect.mapError(() => new MarketError({ message: "Invalid supplied Market text" })));
      const available = new Map(texts.map((text) => [text.listing_id, text]));
      const current = new Map(marketAds(capture.ads).map((ad) => [ad.uuid, ad]));
      let textCoverage = 0, occupationCoverage = 0;
      const detailed: MarketAd[] = [];

      for (const candidate of candidates) {
        const ad = current.get(candidate.id);

        if (!ad) return yield* new MarketError({ message: "Filtered Market candidate is not in its source capture" });
        const text = available.get(candidate.id);

        if (text && text.source_version !== candidate.version) return yield* new MarketError({ message: "Review text no longer matches Market source capture" });
        const pairs = capture.occupations[candidate.id] ?? [];

        if (text && text.text.trim()) textCoverage++;

        if (pairs.length) occupationCoverage++;
        detailed.push({ ...ad, text: text?.text ?? "", occupations: pairs.flat().join(" ") });
      }

      const week = captureWeek(isoEpochMillis(instant.value));
      const bounds = periodBounds("week", week);

      if (!bounds) return yield* new MarketError({ message: "Invalid Market capture week" });
      const titles = titlesOnly([...current.values()]);
      const meta = (series: "titles" | "detailed"): MarketCaptureMetadata => ({ profile_id: profile.profile_id, series, capture_week: week, timezone: "Europe/Oslo", membership: "current_unexpired_stock", classifier_engine: "native_js_known_ab_v1", filter_fingerprint: series === "detailed" ? common.preferences_fingerprint : null, population: series === "titles" ? titles.length : detailed.length, text_coverage: series === "detailed" ? textCoverage : 0, occupation_coverage: series === "detailed" ? occupationCoverage : 0 });
      const titlesMeta = meta("titles"), detailedMeta = meta("detailed");
      const path = recordingPath(profile);
      const exists = yield* fs.exists(path);

      const writePath = exists ? path : yield* Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        const temporary = yield* fs.makeTempFileScoped({ directory: dirname(path), prefix: ".market-snapshots-" });
        yield* fs.chmod(temporary, 0o600);

        return temporary;
      });

      // Close SQLite before publishing a new store. An interrupted first write
      // can leave only an owned temporary sibling, never an invalid final path.
      yield* Effect.scoped(Effect.gen(function* () {
        const sql = yield* acquireSqliteResource({ filename: writePath, readonly: false, readwrite: true, create: false }).pipe(Effect.provide(Reactivity.layer), Effect.catchAllDefect(marketOpenFailure));
        yield* sql`PRAGMA busy_timeout = 5000`;
        yield* sql.withTransaction(Effect.gen(function* () {
          if (!exists) {
            yield* initializeMarketAggregates(sql);
            yield* sql.unsafe(metadataStatement);
          } else {
            const marker = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='market_snapshot_meta'`;

            if (!marker.length) return yield* new MarketError({ message: "Selected file is not a Market recording store" });
            const profiles = yield* sql<{ profile_id: string }>`SELECT DISTINCT profile_id FROM market_snapshot_meta`;

            if (profiles.some((row) => row.profile_id !== profile.profile_id)) return yield* new MarketError({ message: "Market recording belongs to another profile" });
          }

          for (const [label, ads, metadata] of [[week, titles, titlesMeta], [`detail-${week}`, detailed, detailedMeta]] as const) {
            yield* sql`DELETE FROM market_snapshot_meta WHERE snapshot_id IN (SELECT id FROM snapshots WHERE label=${label})`;
            const id = yield* replaceSnapshot(sql, label, ads, tax, { source: "nav-wide current unexpired stock", created_at: now, basis: metadata.series === "titles" ? "titles" : "titles+text", period_start: bounds[0], period_end: bounds[1] });
            yield* sql`INSERT INTO market_snapshot_meta (snapshot_id,profile_id,series,capture_week,timezone,membership,classifier_engine,filter_fingerprint,population,text_coverage,occupation_coverage) VALUES (${id},${metadata.profile_id},${metadata.series},${metadata.capture_week},${metadata.timezone},${metadata.membership},${metadata.classifier_engine},${metadata.filter_fingerprint},${metadata.population},${metadata.text_coverage},${metadata.occupation_coverage})`;
          }
        }));
      }));

      // Atomic exclusive publication refuses any path that appeared meanwhile.
      if (!exists) yield* fs.link(writePath, path);

      return { status: "recorded", week, captured_at: now, titles: titlesMeta, detailed: detailedMeta } as const;
    }).pipe(Effect.scoped, Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(safe)),
    readHistory: (profile, frozenPath) => readHistory(frozenPath, recordingPath(profile), profile.profile_id).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    salary: (sourcePath, listingIds) => readSalaryFacts(sourcePath).pipe(Effect.map((facts) => salarySection(readSalaryRows(facts.salaries, listingIds))), Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(safe)),
    salaryLabels: (sourcePath, versions) => Effect.gen(function* () {
      if (!versions.size || !(yield* fs.exists(sourcePath))) return {};
      const source = yield* readSalaryFacts(sourcePath);
      const facts = new Map(source.salaries.map((row) => [row.uuid, row]));

      return Object.fromEntries([...versions].map(([id, version]) => {
        const row = facts.get(id);

        return [id, displayLabel(row?.detail_changed === version ? row : null, source.text_versions[id] === version)];
      }));
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.catchAll(() => Effect.succeed({}))),
  };
}));
