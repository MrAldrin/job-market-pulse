import { Reactivity } from "@effect/experimental";
import { Clock, Context, Effect, Either, Layer, Predicate, Schema } from "effect";
import { stat } from "node:fs/promises";
import { decodeSnapshotDocumentBytes } from "../../contracts/snapshot.ts";
import { readReadonlySqlite } from "../shared/readonly-sqlite.ts";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { SnapshotError } from "./errors.ts";

const HTML_LIMIT = 2_000_000;
const ROW_LIMIT = 10_000_000;
const SHORTLIST_LIMIT = 2_000_100;
const STARRED_LIMIT = 2 * 1024 * 1024;
const JSON_LIMIT = 8_000_000;
const legacyPage = Schema.String.pipe(Schema.filter((value) => value.isWellFormed()));

const LegacyBundle = Schema.Struct({
  version: Schema.Literal(1n),
  views: Schema.Struct({ fit: legacyPage, evidence: legacyPage, market: legacyPage, calibrate: legacyPage, about: legacyPage }),
});

const profileId = Schema.String.pipe(Schema.maxLength(64), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/));
const listingId = Schema.String.pipe(Schema.pattern(/^[a-z0-9_-]{1,128}(?![\s\S])/));
const listingIds = Schema.Array(listingId).pipe(Schema.maxItems(66_666), Schema.filter((ids) => new Set(ids).size === ids.length));
const Shortlist = Schema.Struct({ profile_id: profileId, listing_ids: listingIds });

export type ShortlistMetadata = typeof Shortlist.Type;

const text = (length: number) => Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.filter((value) => Array.from(value).length <= length && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))));

const utcStamp = Schema.NullOr(Schema.String.pipe(Schema.filter((value) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/.test(value)) return false;
  const date = new Date(value);

  return Number.isFinite(date.getTime()) && date.toISOString().replace('.000Z', '+00:00') === value;
})));

const Starred = Schema.Struct({
  schema_version: Schema.Literal(1), profile_id: profileId,
  jobs: Schema.Array(Schema.Struct({ listing_id: listingId, summary: Schema.Struct({
    title: text(512), employer: text(512), deadline: text(512), expires_at: utcStamp,
    source_status: Schema.Literal("active", "closed", "unknown"), source_version: text(128), source_checked_at: utcStamp,
  }) })).pipe(Schema.maxItems(66_666), Schema.filter((jobs) => jobs.every((job, index) => index === 0 || (jobs[index - 1]?.listing_id ?? "") < job.listing_id))),
});

export type StarredMetadata = typeof Starred.Type;

export interface PublishSnapshot {
  readonly html: Uint8Array;
  readonly dashboardJson?: Uint8Array | null;
  readonly dashboardBundle?: Uint8Array | null;
  readonly shortlist?: ShortlistMetadata | null;
  readonly starred?: StarredMetadata | null;
  readonly publishedAt?: string;
  readonly keep?: number;
}

export interface SnapshotRecord {
  readonly publishedAt: string;
  readonly html: Uint8Array;
  // Opaque legacy transport only. New captures never write dashboard pages.
  readonly dashboardBundle: Uint8Array | null;
  readonly dashboardJson: Uint8Array | null;
  readonly shortlist: ShortlistMetadata | null;
  readonly starred: StarredMetadata | null;
}

// SQL values are checked before fetching any potentially oversized payload.
interface SnapshotSqlRow {
  readonly [column: string]: string | number | Uint8Array | null;
}

const invalid = (message: string) => new SnapshotError({ message });
const attempt = <A>(operation: () => A) => Effect.try({ try: operation, catch: () => invalid("Invalid snapshot payload") });
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const validate = <A, I, V>(schema: Schema.Schema<A, I>, value: V): A => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const metadataBytes = <A, I>(schema: Schema.Schema<A, I>, value: A | null | undefined, limit: number): Uint8Array | null => {
  if (value === undefined || value === null) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(validate(schema, value)));

  if (bytes.byteLength > limit) throw invalid("Snapshot metadata exceeds its size limit");

  return bytes;
};

const decodeMetadata = <A, I>(schema: Schema.Schema<A, I>, bytes: Uint8Array, limit: number): A => {
  const parsed = parseStrictContractBytes(bytes, limit);

  if (Either.isLeft(parsed)) throw invalid("Invalid snapshot metadata JSON");
  const value = parsed.right;

  if ("schema_version" in value && value.schema_version !== 1n) throw invalid("Unsupported metadata schema version");

  // Strict JSON keeps integer tokens as bigint; the wire schema requires integer 1.
  return validate(schema, value.schema_version === 1n ? { ...value, schema_version: 1 } : value);
};

const validateJson = (bytes: Uint8Array | null) => {
  if (bytes !== null && (bytes.byteLength > JSON_LIMIT || Either.isLeft(decodeSnapshotDocumentBytes(bytes)))) throw invalid("Invalid dashboard snapshot JSON");
};

const validateLegacyBundle = (bytes: Uint8Array | null): void => {
  if (bytes === null) return;

  const parsed = parseStrictContractBytes(bytes, ROW_LIMIT);

  if (Either.isLeft(parsed)) throw invalid("Invalid legacy dashboard bundle JSON");
  validate(LegacyBundle, parsed.right);
};

const exists = (path: string) => Effect.tryPromise({
  try: async () => {
    try {
      const info = await stat(path);

      if (!info.isFile()) throw invalid("Snapshot path is not a file");

      return true;
    } catch (error) {
      if (Either.isRight(Schema.decodeUnknownEither(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error))) return false;
      throw error;
    }
  },
  catch: () => invalid("Cannot inspect snapshot file"),
});

const refuseFeedback = (sql: SqliteResource) => Effect.gen(function* () {
  const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shortlist_feedback'`;

  if (rows.length) return yield* Effect.fail(invalid("Snapshot database cannot be the feedback interaction store"));
});

const nullableColumns = ["dashboard_bundle", "shortlist_metadata", "starred_metadata", "dashboard_json"] as const;
const limits = { html: HTML_LIMIT, dashboard_bundle: ROW_LIMIT, shortlist_metadata: SHORTLIST_LIMIT, starred_metadata: STARRED_LIMIT, dashboard_json: JSON_LIMIT };
const columns = (sql: SqliteResource) => sql<{ name: string }>`PRAGMA table_info(digest_snapshots)`.pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));

const acquire = (path: string, readonly: boolean) => Effect.gen(function* () {
  const sql = yield* acquireSqliteResource({ filename: path, readonly, create: !readonly, readwrite: !readonly }).pipe(
    Effect.catchAllDefect(() => Effect.fail(invalid("Snapshot store could not be opened"))),
  );

  yield* sql`PRAGMA busy_timeout = 5000`;

  if (readonly) yield* sql`PRAGMA query_only = ON`;

  return sql;
});

const errors = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(
  Effect.catchAll((error) => Effect.fail(error instanceof SnapshotError ? error : invalid("Snapshot store operation failed"))),
);

export const publishSnapshot = (path: string, input: PublishSnapshot): Effect.Effect<number, SnapshotError> => errors(Effect.scoped(Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;

  const payload = yield* attempt(() => {
    if (!(input.html instanceof Uint8Array) || input.html.byteLength > HTML_LIMIT) throw invalid("Invalid snapshot HTML");
    utf8(input.html);

    if (input.keep !== undefined && (!Number.isSafeInteger(input.keep) || input.keep < 1)) throw invalid("keep must be a positive integer");

    if (input.publishedAt !== undefined && (!Predicate.isString(input.publishedAt) || !input.publishedAt.isWellFormed())) throw invalid("Invalid published timestamp");
    const html = Uint8Array.from(input.html);

    if (input.dashboardJson != null && (!(input.dashboardJson instanceof Uint8Array) || input.dashboardJson.byteLength > JSON_LIMIT)) throw invalid("Dashboard JSON must be bounded bytes");
    const json = input.dashboardJson == null ? null : Uint8Array.from(input.dashboardJson);
    validateJson(json);

    if (input.dashboardBundle != null && (!(input.dashboardBundle instanceof Uint8Array) || input.dashboardBundle.byteLength > ROW_LIMIT)) throw invalid("Legacy dashboard bundle must be bounded bytes");
    const bundle = input.dashboardBundle == null ? null : Uint8Array.from(input.dashboardBundle);
    validateLegacyBundle(bundle);
    const shortlist = metadataBytes(Shortlist, input.shortlist, SHORTLIST_LIMIT);
    const starred = metadataBytes(Starred, input.starred, STARRED_LIMIT);

    if (html.byteLength + (json?.byteLength ?? 0) + (bundle?.byteLength ?? 0) + (shortlist?.byteLength ?? 0) + (starred?.byteLength ?? 0) > ROW_LIMIT) throw invalid("Snapshot row exceeds aggregate size limit");

    return { html, json, bundle, shortlist, starred, stamp: input.publishedAt || new Date(now).toISOString().replace(/\.\d{3}Z$/, "+00:00"), keep: input.keep };
  });

  // Refuse interaction stores before a writable connection can change them.
  if (yield* exists(path)) {
    yield* Effect.scoped(Effect.gen(function* () { const sql = yield* acquire(path, true); yield* refuseFeedback(sql); }));
  }

  const sql = yield* acquire(path, false);

  return yield* sql.withTransaction(Effect.gen(function* () {
    yield* refuseFeedback(sql);
    yield* sql`CREATE TABLE IF NOT EXISTS digest_snapshots (id INTEGER PRIMARY KEY, published_at TEXT NOT NULL, html BLOB NOT NULL, dashboard_bundle BLOB, shortlist_metadata BLOB, starred_metadata BLOB, dashboard_json BLOB)`;
    const present = yield* columns(sql);

    for (const column of nullableColumns) {
      if (!present.has(column)) yield* sql.unsafe(`ALTER TABLE digest_snapshots ADD COLUMN ${column} BLOB`);
    }

    const inserted = yield* sql<{ id: number }>`INSERT INTO digest_snapshots (published_at, html, dashboard_bundle, shortlist_metadata, starred_metadata, dashboard_json) VALUES (${payload.stamp}, ${payload.html}, ${payload.bundle}, ${payload.shortlist}, ${payload.starred}, ${payload.json}) RETURNING id`;
    const id = inserted[0]?.id;

    if (!Number.isSafeInteger(id) || id === undefined) return yield* Effect.fail(invalid("SQLite did not return a row id"));

    if (payload.keep !== undefined) yield* sql`DELETE FROM digest_snapshots WHERE id NOT IN (SELECT id FROM digest_snapshots ORDER BY id DESC LIMIT ${payload.keep})`;

    return id;
  }));
})).pipe(Effect.provide(Reactivity.layer)));

const readRecord = (path: string, selectedProfileId?: string): Effect.Effect<SnapshotRecord | null, SnapshotError> => errors(Effect.scoped(Effect.gen(function* () {
  if (selectedProfileId !== undefined) yield* attempt(() => validate(profileId, selectedProfileId));

  if (!(yield* exists(path))) return null;
  const sql = yield* acquire(path, true);

  return yield* sql.readSnapshot(Effect.gen(function* () {
    const present = yield* columns(sql);

    if (!present.size) return null;

    if (!["id", "published_at", "html"].every((column) => present.has(column))) return yield* Effect.fail(invalid("Snapshot table schema is incomplete"));
    const selected: ("html" | typeof nullableColumns[number])[] = ["html", ...nullableColumns.filter((column) => present.has(column))];
    const metaSql = selected.map((column) => `typeof(${column}) AS ${column}_type, length(${column}) AS ${column}_length`).join(", ");
    const metadata = yield* sql.unsafe<SnapshotSqlRow>(`SELECT id, published_at, ${metaSql} FROM digest_snapshots ORDER BY id DESC LIMIT 1`);
    const meta = metadata[0];

    if (!meta) return null;
    yield* attempt(() => {
      let total = 0;

      for (const column of selected) {
        const type = meta[`${column}_type`];
        const length = meta[`${column}_length`];

        if (type === "null" && column !== "html") continue;

        if (type !== "blob" || !Predicate.isNumber(length) || !Number.isSafeInteger(length) || length < 0 || length > (limits[column] ?? 0)) throw invalid("Snapshot payload type or length is invalid");
        total += length;
      }

      if (total > ROW_LIMIT) throw invalid("Snapshot row exceeds aggregate size limit");

      if (!Predicate.isString(meta.published_at) || !Predicate.isNumber(meta.id) || !Number.isSafeInteger(meta.id)) throw invalid("Invalid snapshot row identity");
    });
    const rows = yield* sql.unsafe<SnapshotSqlRow>(`SELECT ${selected.join(", ")} FROM digest_snapshots WHERE id = ?`, [meta.id]);

    return yield* attempt(() => {
      const row = rows[0];

      if (!row) throw invalid("Snapshot row disappeared while being read");

      const blob = (column: string): Uint8Array | null => {
        const value = row[column];

        if (value === null || value === undefined) return null;

        if (!(value instanceof Uint8Array)) throw invalid("Snapshot payload is not a BLOB");

        return Uint8Array.from(value);
      };

      const html = blob("html");

      if (html === null) throw invalid("Snapshot HTML is missing");
      utf8(html);
      const shortlistBytes = blob("shortlist_metadata");
      const shortlist = shortlistBytes === null ? null : decodeMetadata(Shortlist, shortlistBytes, SHORTLIST_LIMIT);

      if (selectedProfileId !== undefined && (shortlist === null || shortlist.profile_id !== selectedProfileId)) throw invalid("Snapshot has no matching shortlist profile identity");
      const starredBytes = blob("starred_metadata");
      const dashboardJson = blob("dashboard_json");

      validateJson(dashboardJson);
      const dashboardBundle = blob("dashboard_bundle");
      validateLegacyBundle(dashboardBundle);

      return {
        publishedAt: String(meta.published_at), html, dashboardBundle, dashboardJson, shortlist,
        starred: starredBytes === null ? null : decodeMetadata(Starred, starredBytes, STARRED_LIMIT),
      };
    });
  }));
})).pipe(Effect.provide(Reactivity.layer)));

export const latestSnapshotRecord = (path: string) => readRecord(path);
export const readSnapshotRecord = (path: string, selectedProfileId: string) => readRecord(path, selectedProfileId);

type StarredSnapshotMetadata = Pick<SnapshotRecord, "publishedAt" | "starred">;

interface StarredMetaRow {
  readonly id: unknown;
  readonly published_at: unknown;
  readonly metadata_type: unknown;
  readonly metadata_length: unknown;
}

const isUtcStamp = Schema.is(utcStamp);

/** Read only the newest structured metadata. Do not load HTML, JSON or the dashboard bundle. */
export const readLatestStarredMetadata = (path: string) => readReadonlySqlite(path, "snapshot", (db): StarredSnapshotMetadata | null => {
  const unavailable = () => invalid("Starred snapshot metadata is unavailable");
  const table = db.query<{ type: string }, []>("SELECT type FROM main.sqlite_master WHERE name = 'digest_snapshots' LIMIT 1").get();

  if (table?.type !== "table") throw unavailable();

  const present = new Set(db.query<{ name: string }, []>("PRAGMA main.table_info(digest_snapshots)").all().map(({ name }) => name));

  if (!present.has("id") || !present.has("published_at")) throw unavailable();

  const row = present.has("starred_metadata")
    ? db.query<StarredMetaRow, []>(`SELECT id, published_at, typeof(starred_metadata) AS metadata_type,
        length(starred_metadata) AS metadata_length FROM main.digest_snapshots ORDER BY id DESC LIMIT 1`).get()
    : db.query<StarredMetaRow, []>(`SELECT id, published_at, 'null' AS metadata_type,
        NULL AS metadata_length FROM main.digest_snapshots ORDER BY id DESC LIMIT 1`).get();

  if (row === null) return null;

  const { id, published_at: publishedAt, metadata_type: type, metadata_length: length } = row;

  if (!Predicate.isBigInt(id) || !Predicate.isString(publishedAt) || !isUtcStamp(publishedAt) || publishedAt.startsWith("0000-")) throw unavailable();

  if (type === "null") return { publishedAt, starred: null };

  if (type !== "blob" || !Predicate.isBigInt(length) || length < 0n || length > BigInt(STARRED_LIMIT)) throw unavailable();

  const blobs = db.query<{ starred_metadata: unknown }, [bigint, bigint]>(`SELECT CASE
      WHEN typeof(starred_metadata) = 'blob' AND length(starred_metadata) = ? THEN starred_metadata
    END AS starred_metadata FROM main.digest_snapshots WHERE id = ? LIMIT 2`).all(length, id);

  const bytes = blobs[0]?.starred_metadata;

  if (blobs.length !== 1 || !(bytes instanceof Uint8Array) || BigInt(bytes.byteLength) !== length) throw unavailable();

  return { publishedAt, starred: decodeMetadata(Starred, bytes, STARRED_LIMIT) };
}).pipe(Effect.mapError(() => invalid("Starred snapshot metadata is unavailable")));

export class SnapshotStore extends Context.Tag("pulse/SnapshotStore")<SnapshotStore, {
  readonly publish: typeof publishSnapshot;
  readonly latest: typeof latestSnapshotRecord;
  readonly readProfile: typeof readSnapshotRecord;
}>() {}

export const SnapshotStoreLive = Layer.succeed(SnapshotStore, { publish: publishSnapshot, latest: latestSnapshotRecord, readProfile: readSnapshotRecord });
