import { Database } from "bun:sqlite";
import { Data, Effect, Schema } from "effect";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const maxDatabaseBytes = 32 * 1024 * 1024;

class ReadonlySqliteError extends Data.TaggedError("ReadonlySqliteError")<{ readonly message: string }> {}

const unavailable = () => new ReadonlySqliteError({ message: "SQLite source is unavailable" });

// The owning brick supplies fixed SELECTs. They share one read transaction.
export const readReadonlySqlite = <A>(path: string, source: "feedback" | "snapshot", read: (db: Database) => A) => Effect.tryPromise({
  try: async () => {
    const filename = resolve(path);

    const info = await stat(filename).catch((error) => {
      if (source === "snapshot" && missing(error)) return null;
      throw error;
    });

    if (info === null) return null;

    if (!info.isFile() || info.size < 100 || info.size > maxDatabaseBytes) throw unavailable();

    if (source === "feedback" && (info.mode & 0o077) !== 0) throw unavailable();
    const db = new Database(filename, { readonly: true, strict: true, safeIntegers: true });

    try {
      db.run("PRAGMA busy_timeout = 100");
      db.run("PRAGMA query_only = ON");
      db.run("BEGIN");

      try { return read(db); } finally { db.run("ROLLBACK"); }
    } finally { db.close(); }
  },
  catch: unavailable,
});
