import { FileSystem } from "@effect/platform";
import { Reactivity } from "@effect/experimental";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Either, Schema, Scope } from "effect";
import { isAbsolute } from "node:path";
import { SourceError } from "./errors.ts";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";

export type SourceSql = SqliteResource;

export type StoreError = SourceError | SqlError;

// No default path or layer-time acquisition. Each selected operation owns its scope.
export const acquireStore = (path: string, mode: "readonly" | "existing" | "create"): Effect.Effect<SourceSql, SourceError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!isAbsolute(path)) return yield* new SourceError({ message: "Source database path must be explicit and absolute" });

    if (mode !== "create") {
      const info = yield* fs.stat(path).pipe(Effect.mapError(() => new SourceError({ message: "Source database is unavailable" })));

      if (info.type !== "File") return yield* new SourceError({ message: "Source database is unavailable" });
    }

    const sql = yield* acquireSqliteResource({
      filename: path, readonly: mode === "readonly", readwrite: mode !== "readonly",
      create: mode === "create",
    }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.catchAllDefect((defect) => {
        const decoded = Schema.decodeUnknownEither(Schema.Struct({ code: Schema.String }))(defect);
        const code = Either.isRight(decoded) ? decoded.right.code : undefined;

        return code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY" || code === "EACCES" || code === "ENOENT"
          ? Effect.fail(new SourceError({ message: "Source database is unavailable" }))
          : Effect.die(defect);
      }),
    );

    // sqlite3.connect's timeout is 5 seconds; do not enable the driver's WAL default.
    yield* sql`PRAGMA busy_timeout = 5000`.pipe(Effect.mapError(() => new SourceError({ message: "Cannot configure source connection" })));

    if (mode === "readonly") yield* sql`PRAGMA query_only = ON`.pipe(Effect.mapError(() => new SourceError({ message: "Cannot configure source connection" })));

    return sql;
  });

// Pin only this resource's connection; foreign and driver-global transactions stay separate.
export const withReservedConnection = <A, E, R>(sql: SourceSql, program: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> => sql.withConnection(program);

export const readSnapshot = <A, E, R>(sql: SourceSql, program: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> => sql.readSnapshot(program);

export const hasTable = (sql: SourceSql, name: string) => sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`.pipe(Effect.map((rows) => rows.length > 0));

export const sourceSqlError = (_error: SqlError): SourceError => new SourceError({ message: "Source database operation failed" });
