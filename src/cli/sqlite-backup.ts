import { Database } from "bun:sqlite";
import { Data, Effect } from "effect";
import { chmodSync, linkSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class BackupError extends Data.TaggedError("BackupError")<{ readonly message: string }> {}

export const sqliteBackup = (source: string, output: string) => Effect.try({
  try: () => {
    const input = resolve(source);
    const destination = resolve(output);

    if (!statSync(input).isFile()) throw new Error("Not a database file");
    const directory = mkdtempSync(join(dirname(destination), ".pulse-backup-"));
    const copy = join(directory, "backup.sqlite3");

    try {
      const database = new Database(input, { readonly: true, create: false });

      try { database.run("VACUUM INTO ?", [copy]); } finally { database.close(); }

      chmodSync(copy, 0o600);
      const backup = new Database(copy, { create: false });

      try {
        if (backup.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ad_texts'").get() !== null) {
          backup.run("PRAGMA secure_delete = ON");
          backup.run("DELETE FROM ad_texts");
          backup.run("VACUUM");
        }
      } finally { backup.close(); }
      // A hard link publishes the completed private file without replacing an existing backup.

      linkSync(copy, destination);

      return destination;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
  catch: () => new BackupError({ message: "Cannot create backup. Check the source, output directory and that the output does not already exist." }),
});
