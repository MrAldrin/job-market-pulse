import { Effect, Either, Option, Schema } from "effect";
import type { FileSystem } from "@effect/platform";
import { ApplicationDeadline, CurrentAdEvidence, CurrentAdRow, DetailEvidence, LocationEvidence, ManifestSourceSnapshot, RelevanceSourceSnapshot, SourceAd, SourceStatus, type OccupationPair } from "../../contracts/source-readers.ts";
import { parseJsonInput, type JsonInput } from "../shared/json-input.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { verifyWorkplaceEvidence } from "../shared/workplace-fingerprint.ts";
import { acquireStore, hasTable, readSnapshot, type SourceSql } from "./store.ts";
import { timestamp } from "./core.ts";
import { SourceError } from "./errors.ts";

export type { LocationPoints, ManifestSourceSnapshot, RelevanceSourceSnapshot } from "../../contracts/source-readers.ts";

const decode = <A, I, Input>(schema: Schema.Schema<A, I>, value: Input) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "preserve" })(value).pipe(
    Either.mapLeft(() => new SourceError({ message: "Invalid source reader data" })),
  );

const LocationRow = Schema.Struct({ uuid: Schema.String, ...LocationEvidence.fields });

type LocationRow = typeof LocationRow.Type;

const OccupationRow = Schema.Struct({ uuid: Schema.String, level1: Schema.String, level2: Schema.String });

type OccupationRow = typeof OccupationRow.Type;

const VersionRow = Schema.Struct({ uuid: Schema.String, changed: Schema.String });

const DetailRow = Schema.Struct({ uuid: Schema.String, ...DetailEvidence.fields });

const pairOrder = (a: OccupationPair, b: OccupationPair) => codepointOrder(a[0], b[0]) || codepointOrder(a[1], b[1]);

const uniquePairs = (rows: readonly OccupationPair[]) => [...new Map(rows.map((pair) => [JSON.stringify(pair), pair])).values()].sort(pairOrder);

const pairs = (rows: readonly OccupationRow[]) => {
  const result: Record<string, OccupationPair[]> = Object.create(null);

  for (const row of rows) (result[row.uuid] ??= []).push([row.level1, row.level2]);

  return Object.fromEntries(Object.entries(result));
};

const points = (rows: readonly LocationRow[]) => Effect.gen(function* () {
  const result: Record<string, readonly [readonly JsonInput[], boolean]> = Object.create(null);

  for (const row of rows) {
    const parsed = parseJsonInput(row.points);

    if (Either.isLeft(parsed) || !Array.isArray(parsed.right)) return yield* new SourceError({ message: "Invalid location points JSON" });
    result[row.uuid] = [parsed.right, Boolean(row.incomplete)];
  }

  return Object.fromEntries(Object.entries(result));
});

export const hasDetailVersions = (sql: SourceSql) => hasTable(sql, "ad_detail_versions");

export const readHistoricalAd = (sql: SourceSql, id: string) => Effect.gen(function* () {
  const rows = yield* sql`SELECT * FROM ads WHERE uuid=${id}`;

  return yield* decode(Schema.NullOr(CurrentAdRow), rows[0] ?? null);
});

export const readCurrentAd = (sql: SourceSql, id: string, includeDetailVersions: boolean) => Effect.gen(function* () {
  const ad = yield* readHistoricalAd(sql, id);
  const versions = yield* sql`SELECT changed FROM versions WHERE uuid=${id}`;
  const details = includeDetailVersions ? yield* sql`SELECT saved_changed, detail_changed FROM ad_detail_versions WHERE uuid=${id}` : [];
  const locations = (yield* hasTable(sql, "ad_locations")) ? yield* sql`SELECT points, incomplete, provenance FROM ad_locations WHERE uuid=${id}` : [];
  const occupations = (yield* hasTable(sql, "ad_occupations")) ? yield* sql`SELECT level1, level2 FROM ad_occupations WHERE uuid=${id} AND scheme='occupationCategories' AND level1 != ''` : [];
  const occupation_pairs = uniquePairs(yield* decode(Schema.Array(Schema.Tuple(Schema.String, Schema.String)), occupations.map((row) => [row.level1, row.level2])));

  return yield* decode(CurrentAdEvidence, { ad, version_exists: versions.length > 0, version_changed: versions[0]?.changed ?? null, detail_evidence: details[0] ?? null, has_location_points: locations.length > 0, occupation_pairs, location_evidence: locations[0] ?? null });
});

export const currentOccupationPairs = (sql: SourceSql) => Effect.gen(function* () {
  const tables = yield* sourceTables(sql);

  if (!["ads", "versions", "ad_occupations", "ad_occupation_checks"].every((name) => tables.has(name))) return {};
  const rows = yield* sql`SELECT ads.uuid, occupations.level1, occupations.level2 FROM ads JOIN versions ON versions.uuid=ads.uuid AND versions.changed=ads.changed JOIN ad_occupation_checks AS checks ON checks.uuid=ads.uuid AND checks.saved_changed=ads.changed LEFT JOIN ad_occupations AS occupations ON occupations.uuid=ads.uuid AND occupations.scheme='occupationCategories' AND occupations.level1 != '' ORDER BY ads.uuid, occupations.level1, occupations.level2`;
  const checked = yield* decode(Schema.Array(Schema.Struct({ uuid: Schema.String, level1: Schema.NullOr(Schema.String), level2: Schema.NullOr(Schema.String) })), rows);
  const result: Record<string, OccupationPair[]> = Object.create(null);

  for (const row of checked) {
    const list = result[row.uuid] ??= [];

    if (row.level1 !== null && row.level2 !== null) list.push([row.level1, row.level2]);
  }

  return Object.fromEntries(Object.entries(result).map(([id, values]) => [id, uniquePairs(values)]));
});

export const sourceTables = (sql: SourceSql) => Effect.gen(function* () {
  const rows = yield* sql`SELECT name FROM sqlite_master WHERE type='table'`;
  const checked = yield* decode(Schema.Array(Schema.Struct({ name: Schema.String })), rows);

  return new Set(checked.map((row) => row.name));
});

export const sourceState = (sql: SourceSql) => Effect.gen(function* () {
  const rows = yield* sql`SELECT key,value FROM state`;
  const checked = yield* decode(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })), rows);

  return Object.fromEntries(checked.map((row) => [row.key, row.value]));
});

export const readStatus = (sql: SourceSql, id: string) => Effect.gen(function* () {
  const rows = yield* sql`SELECT status,changed FROM ad_status_evidence WHERE uuid=${id}`;

  return yield* decode(Schema.NullOr(SourceStatus), rows[0] ? [rows[0].status, rows[0].changed] : null);
});

export const readVersion = (sql: SourceSql, id: string) => Effect.gen(function* () {
  const rows = yield* sql`SELECT changed FROM versions WHERE uuid=${id}`;

  return yield* decode(Schema.NullOr(Schema.String), rows[0]?.changed ?? null);
});

export const readApplicationDeadline = (sql: SourceSql, id: string) => Effect.gen(function* () {
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(ad_application_deadlines)`;
  const rows = columns.some((col) => col.name === "rolling") ? yield* sql`SELECT changed,application_due,rolling FROM ad_application_deadlines WHERE uuid=${id}` : yield* sql`SELECT changed,application_due,0 AS rolling FROM ad_application_deadlines WHERE uuid=${id}`;

  return yield* decode(Schema.NullOr(ApplicationDeadline), rows[0] ? [rows[0].changed, rows[0].application_due, rows[0].rolling] : null);
});

const locationRows = (sql: SourceSql) => Effect.gen(function* () {
  const rows = (yield* hasTable(sql, "ad_locations")) ? yield* sql`SELECT uuid, points, incomplete, provenance FROM ad_locations WHERE provenance != ''` : [];

  return yield* decode(Schema.Array(LocationRow), rows);
});

export const readRelevance = (sql: SourceSql, now: string) => Effect.gen(function* () {
  const utcNow = yield* timestamp(now);
  const locations = yield* locationRows(sql);
  const location_points = yield* points(locations);
  const rows = yield* sql`SELECT * FROM ads WHERE expires IS NULL OR expires > ${utcNow}`;
  const ads = yield* decode(Schema.Array(SourceAd), rows);

  return yield* decode(RelevanceSourceSnapshot, { ads, location_points });
});

export const readManifestSnapshot = (sql: SourceSql, maxListings: number, now: string) => Effect.gen(function* () {
  const utcNow = yield* timestamp(now);
  const state = yield* sourceState(sql);
  const counts = yield* sql`SELECT COUNT(*) AS count FROM ads`;
  const listing_count = yield* decode(Schema.Int, counts[0]?.count);

  if (listing_count > maxListings) return yield* decode(ManifestSourceSnapshot, { state, listing_count, ads: [], location_points: {}, occupation_pairs: {}, location_binding_digests: {} });
  const rows = yield* sql`SELECT * FROM ads WHERE expires IS NULL OR expires > ${utcNow}`;
  const ads = yield* decode(Schema.Array(SourceAd), rows);
  const versions = yield* decode(Schema.Array(VersionRow), yield* sql`SELECT uuid, changed FROM versions`);
  const details = (yield* hasDetailVersions(sql)) ? yield* decode(Schema.Array(DetailRow), yield* sql`SELECT uuid, saved_changed, detail_changed FROM ad_detail_versions`) : [];
  const adsById = new Map(ads.map((ad) => [ad.uuid, ad]));
  const versionsById = new Map(versions.map((row) => [row.uuid, row.changed]));
  const detailsById = new Map(details.map((row) => [row.uuid, row]));
  const locations = yield* locationRows(sql);
  const location_points = yield* points(locations);
  const location_binding_digests: Record<string, string> = Object.create(null);

  for (const row of locations) {
    const ad = adsById.get(row.uuid);

    if (!ad) continue;
    const detail = detailsById.get(row.uuid);
    const input = { provenance: row.provenance, uuid: row.uuid, sourceVersion: ad.changed, versionChanged: versionsById.get(row.uuid) ?? null, incomplete: row.incomplete, pointsJson: row.points };
    const verified = verifyWorkplaceEvidence(detail ? { ...input, currentDetailEvidence: { saved_changed: detail.saved_changed, detail_changed: detail.detail_changed } } : input);

    if (Option.isSome(verified)) location_binding_digests[row.uuid] = verified.value.geography_digest;
  }

  const occupations = (yield* hasTable(sql, "ad_occupations")) ? yield* decode(Schema.Array(OccupationRow), yield* sql`SELECT uuid, level1, level2 FROM ad_occupations WHERE scheme='occupationCategories' AND level1 != ''`) : [];

  return yield* decode(ManifestSourceSnapshot, { state, listing_count, ads, location_points, occupation_pairs: pairs(occupations), location_binding_digests: Object.fromEntries(Object.entries(location_binding_digests)) });
});

export const readManifest = (path: string, maxListings: number, now: string): Effect.Effect<ManifestSourceSnapshot, import("./store.ts").StoreError, FileSystem.FileSystem> => Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "readonly");

  return yield* readSnapshot(sql, readManifestSnapshot(sql, maxListings, now));
}));
