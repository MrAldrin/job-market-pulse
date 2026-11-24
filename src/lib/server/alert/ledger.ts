import { Reactivity } from "@effect/experimental";
import { FileSystem } from "@effect/platform";
import { Clock, Context, Effect, Either, Layer, Schema } from "effect";
import { isAbsolute } from "node:path";
import { DeliveryItem, DeliveryProfileId, DeliveryStatus } from "../../contracts/alert.ts";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";
import { compareItems } from "./core.ts";
import { AlertError } from "./errors.ts";

const failure = (code = "ledger_invalid") => new AlertError({ code });
const keySchema = DeliveryItem.fields.id;
const hashSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$(?![\s\S])/));

const rowSchema = Schema.Struct({
  profile_id: DeliveryProfileId, digest_key: keySchema, payload_hash: hashSchema,
  has_html: Schema.Literal(0, 1), status: DeliveryStatus,
  created_at: Schema.String, updated_at: Schema.String,
});

export type LedgerRow = typeof rowSchema.Type;

export interface LedgerSnapshot {
  readonly row: LedgerRow;
  readonly items: readonly DeliveryItem[];
}

const stageSchema = Schema.Struct({
  digest_key: keySchema, payload_hash: hashSchema, has_html: Schema.Boolean,
  items: Schema.Array(DeliveryItem),
}).pipe(Schema.filter((value) => new Set(value.items.map((item) => item.id)).size === value.items.length));

export type LedgerStage = typeof stageSchema.Type;

export interface LedgerExpectation {
  readonly status: DeliveryStatus;
  readonly payload_hash: string;
  readonly items: readonly DeliveryItem[];
}

export interface DeliveryLedgerConfig {
  readonly databasePath: string;
  readonly profileId: string;
  // The private-file adapter checks permissions before opening the ledger.
  readonly prepareWrite: Effect.Effect<void, AlertError>;
  readonly verifyRead: Effect.Effect<void, AlertError>;
}

const tables = {
  metadata: { columns: { key: "TEXT", value: "TEXT" }, pk: ["key"] },
  digests: { columns: { profile_id: "TEXT", digest_key: "TEXT", payload_hash: "TEXT", has_html: "INTEGER", status: "TEXT", created_at: "TEXT", updated_at: "TEXT" }, pk: ["profile_id", "digest_key"] },
  digest_items: { columns: { profile_id: "TEXT", digest_key: "TEXT", item_id: "TEXT", item_version: "TEXT" }, pk: ["profile_id", "digest_key", "item_id"] },
  notified_versions: { columns: { profile_id: "TEXT", item_id: "TEXT", item_version: "TEXT", digest_key: "TEXT", delivered_at: "TEXT" }, pk: ["profile_id", "item_id", "item_version"] },
};

const sameItems = (left: readonly DeliveryItem[], right: readonly DeliveryItem[]) => {
  const a = [...left].sort(compareItems);
  const b = [...right].sort(compareItems);

  return a.length === b.length && a.every((item, index) => item.id === b[index]?.id && item.version === b[index]?.version);
};

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString().replace(/(\.\d{3})Z$/, "$1000+00:00")));

const initialize = (sql: SqliteResource, profileId: string) => Effect.gen(function* () {
  yield* sql`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  // sqlite_master SQL text is part of the frozen ledger boundary, including whitespace.
  yield* sql`CREATE TABLE digests (
                profile_id TEXT NOT NULL,
                digest_key TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                has_html INTEGER NOT NULL CHECK (has_html IN (0, 1)),
                status TEXT NOT NULL CHECK (
                    status IN ('staged', 'delivered', 'failed', 'uncertain')
                ),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (profile_id, digest_key)
            )`;
  yield* sql`CREATE TABLE digest_items (
                profile_id TEXT NOT NULL,
                digest_key TEXT NOT NULL,
                item_id TEXT NOT NULL,
                item_version TEXT NOT NULL,
                PRIMARY KEY (profile_id, digest_key, item_id),
                FOREIGN KEY (profile_id, digest_key)
                    REFERENCES digests (profile_id, digest_key)
                    ON DELETE CASCADE
            )`;
  yield* sql`CREATE TABLE notified_versions (
                profile_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                item_version TEXT NOT NULL,
                digest_key TEXT NOT NULL,
                delivered_at TEXT NOT NULL,
                PRIMARY KEY (profile_id, item_id, item_version)
            )`;
  yield* sql`INSERT INTO metadata (key, value) VALUES ('profile_id', ${profileId}), ('schema_version', '2')`;
});

const validateSchema = (sql: SqliteResource, profileId: string) => Effect.gen(function* () {
  const objects = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`;

  if (objects.length !== 4 || objects.some((object) => object.type !== "table" || !Object.hasOwn(tables, object.name))) return yield* failure();

  for (const [name, expected] of Object.entries(tables)) {
    const columns = yield* sql.unsafe<{ name: string; type: string; pk: number }>(`PRAGMA table_info("${name}")`);
    const expectedColumns = Object.entries(expected.columns);
    const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);

    if (columns.length !== expectedColumns.length || expectedColumns.some(([key, type]) => !columns.some((column) => column.name === key && column.type.toUpperCase() === type))
      || JSON.stringify(primary) !== JSON.stringify(expected.pk)) return yield* failure();
  }

  const foreignKeys = yield* sql<{ table: string; from: string; to: string }>`PRAGMA foreign_key_list("digest_items")`;

  if (foreignKeys.length !== 2 || !["profile_id", "digest_key"].every((key) => foreignKeys.some((entry) => entry.table === "digests" && entry.from === key && entry.to === key))) return yield* failure();
  const metadata = yield* sql<{ key: string; value: string }>`SELECT key, value FROM metadata`;

  if (metadata.length !== 2 || !metadata.some((entry) => entry.key === "schema_version" && entry.value === "2")) return yield* failure();

  if (!metadata.some((entry) => entry.key === "profile_id" && entry.value === profileId)) return yield* failure("profile_mismatch");
});

export const makeDeliveryLedger = (config: DeliveryLedgerConfig) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const profileId = yield* Schema.decodeUnknown(DeliveryProfileId)(config.profileId).pipe(Effect.mapError(() => failure("profile_invalid")));

  if (!isAbsolute(config.databasePath)) return yield* failure("ledger_path_invalid");
  const path = config.databasePath;
  const exists = fs.stat(path).pipe(Effect.as(true), Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(failure())), Effect.mapError(() => failure()));

  const run = <A, R>(writer: boolean, program: (sql: SqliteResource) => Effect.Effect<A, AlertError | import("@effect/sql/SqlError").SqlError, R>) => Effect.scoped(Effect.gen(function* () {
    if (writer) yield* config.prepareWrite;
    else yield* config.verifyRead;

    const empty = writer && (yield* fs.stat(path)).size === 0n;

    const sql = yield* acquireSqliteResource({ filename: path, readonly: !writer, readwrite: writer, create: false }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.catchAllDefect((defect) => {
        const decoded = Schema.decodeUnknownEither(Schema.Struct({ code: Schema.String }))(defect);
        const code = Either.isRight(decoded) ? decoded.right.code : undefined;

        return code !== undefined && ["SQLITE_CANTOPEN", "SQLITE_READONLY", "EACCES", "ENOENT"].includes(code)
          ? Effect.fail(failure()) : Effect.die(defect);
      }),
    );

    yield* sql`PRAGMA busy_timeout = 30000`;
    yield* sql`PRAGMA foreign_keys = ON`;

    if (writer) {
      yield* sql`PRAGMA journal_mode = DELETE`;
      yield* sql`PRAGMA synchronous = FULL`;
    } else yield* sql`PRAGMA query_only = ON`;

    return yield* sql.withTransaction(Effect.gen(function* () {
      const objects = yield* sql<{ name: string }>`SELECT name FROM sqlite_master`;

      if (empty && objects.length === 0) yield* initialize(sql, profileId);
      yield* validateSchema(sql, profileId);

      return yield* program(sql);
    }));
  })).pipe(Effect.mapError((error) => error instanceof AlertError ? error : failure()));

  const decodeRow = Schema.decodeUnknown(rowSchema);

  const read = (sql: SqliteResource, key: string) => Effect.gen(function* () {
    const rows = yield* sql`SELECT * FROM digests WHERE profile_id = ${profileId} AND digest_key = ${key}`;

    if (rows.length === 0) return yield* failure("digest_not_found");

    if (rows.length !== 1) return yield* failure();
    const row = yield* decodeRow(rows[0]).pipe(Effect.mapError(() => failure()));
    const entries = yield* sql<{ profile_id: unknown; digest_key: unknown; item_id: unknown; item_version: unknown }>`SELECT profile_id, digest_key, item_id, item_version FROM digest_items WHERE profile_id = ${profileId} AND digest_key = ${key}`;
    const items: DeliveryItem[] = [];

    for (const entry of entries) {
      if (entry.profile_id !== profileId || entry.digest_key !== key) return yield* failure();
      items.push(yield* Schema.decodeUnknown(DeliveryItem)({ id: entry.item_id, version: entry.item_version }).pipe(Effect.mapError(() => failure())));
    }

    if (new Set(items.map((item) => item.id)).size !== items.length || row.profile_id !== profileId || row.digest_key !== key) return yield* failure();

    return { row, items } satisfies LedgerSnapshot;
  });

  const validKey = (key: string) => Schema.decodeUnknown(keySchema)(key).pipe(Effect.mapError(() => failure("digest_invalid")));

  return {
    stage: <R>(input: LedgerStage, install: Effect.Effect<void, AlertError, R>) => Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknown(stageSchema)(input).pipe(Effect.mapError(() => failure("digest_invalid")));

      return yield* run(true, (sql) => Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM digests WHERE profile_id = ${profileId} AND digest_key = ${payload.digest_key}`;

        if (rows.length > 0) {
          const existing = yield* read(sql, payload.digest_key);

          if (existing.row.payload_hash !== payload.payload_hash || existing.row.has_html !== Number(payload.has_html) || !sameItems(existing.items, payload.items)) return yield* failure("digest_conflict");
          yield* install;

          return existing.row;
        }

        yield* install;
        const timestamp = yield* now;
        yield* sql`INSERT INTO digests (profile_id, digest_key, payload_hash, has_html, status, created_at, updated_at) VALUES (${profileId}, ${payload.digest_key}, ${payload.payload_hash}, ${Number(payload.has_html)}, 'staged', ${timestamp}, ${timestamp})`;

        for (const item of payload.items) yield* sql`INSERT INTO digest_items (profile_id, digest_key, item_id, item_version) VALUES (${profileId}, ${payload.digest_key}, ${item.id}, ${item.version})`;

        return (yield* read(sql, payload.digest_key)).row;
      }));
    }),
    readDigest: (key: string) => Effect.gen(function* () {
      yield* validKey(key);

      if (!(yield* exists)) return yield* failure("digest_not_found");

      return yield* run(false, (sql) => read(sql, key));
    }),
    list: () => Effect.gen(function* () {
      if (!(yield* exists)) return [];

      return yield* run(false, (sql) => Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM digests WHERE profile_id = ${profileId} ORDER BY created_at, digest_key`;

        return yield* Effect.forEach(rows, (row) => decodeRow(row)).pipe(Effect.mapError(() => failure()));
      }));
    }),
    notifiedVersions: () => Effect.gen(function* () {
      if (!(yield* exists)) return [];

      return yield* run(false, (sql) => Effect.gen(function* () {
        const rows = yield* sql<{ item_id: unknown; item_version: unknown }>`SELECT item_id, item_version FROM notified_versions WHERE profile_id = ${profileId} ORDER BY item_id, item_version`;

        return yield* Effect.forEach(rows, (row) => Schema.decodeUnknown(DeliveryItem)({ id: row.item_id, version: row.item_version }).pipe(Effect.mapError(() => failure())));
      }));
    }),
    claim: (key: string, expected?: LedgerExpectation) => Effect.gen(function* () {
      yield* validKey(key);

      return yield* run(true, (sql) => Effect.gen(function* () {
        const snapshot = yield* read(sql, key);

        if (snapshot.row.status !== "staged" && snapshot.row.status !== "failed") return yield* failure("digest_not_dispatchable");

        if (expected && (snapshot.row.status !== expected.status || snapshot.row.payload_hash !== expected.payload_hash || !sameItems(snapshot.items, expected.items))) return yield* failure("digest_changed");
        const timestamp = yield* now;
        yield* sql`UPDATE digests SET status = 'uncertain', updated_at = ${timestamp} WHERE profile_id = ${profileId} AND digest_key = ${key}`;

        return (yield* read(sql, key)).row;
      }));
    }),
    mark: (key: string, outcome: "delivered" | "failed" | "uncertain", confirmed?: boolean) => Effect.gen(function* () {
      yield* validKey(key);

      if (!["delivered", "failed", "uncertain"].includes(outcome) || (outcome === "delivered" && confirmed !== true)) return yield* failure("confirmation_required");

      return yield* run(true, (sql) => Effect.gen(function* () {
        const { row } = yield* read(sql, key);

        if (row.status === "delivered") return outcome === "delivered" ? row : yield* failure("delivered_cannot_downgrade");
        const timestamp = yield* now;
        yield* sql`UPDATE digests SET status = ${outcome}, updated_at = ${timestamp} WHERE profile_id = ${profileId} AND digest_key = ${key}`;

        if (outcome === "delivered") yield* sql`INSERT INTO notified_versions (profile_id, item_id, item_version, digest_key, delivered_at) SELECT profile_id, item_id, item_version, digest_key, ${timestamp} FROM digest_items WHERE profile_id = ${profileId} AND digest_key = ${key} ON CONFLICT (profile_id, item_id, item_version) DO UPDATE SET digest_key = excluded.digest_key, delivered_at = excluded.delivered_at`;

        return (yield* read(sql, key)).row;
      }));
    }),
  };
});

export type DeliveryLedgerService = Effect.Effect.Success<ReturnType<typeof makeDeliveryLedger>>;

export class DeliveryLedger extends Context.Tag("pulse/DeliveryLedger")<DeliveryLedger, DeliveryLedgerService>() {}

export const DeliveryLedgerLive = (config: DeliveryLedgerConfig) => Layer.effect(DeliveryLedger, makeDeliveryLedger(config));
