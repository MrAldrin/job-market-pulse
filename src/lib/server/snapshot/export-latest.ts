import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname } from "node:path";
import { SnapshotError } from "./errors.ts";
import { SnapshotPaths } from "./paths.ts";
import { SnapshotStore } from "./store.ts";

// Export only the newest row. Older private digests stay in the original store.
export const exportLatestSnapshot = (source: string, destination: string) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* SnapshotPaths;
  const store = yield* SnapshotStore;
  const output = yield* paths.output(destination, [{ path: source, database: true }]);

  if (yield* fs.exists(output)) return yield* new SnapshotError({ message: "Snapshot export destination already exists" });
  const latest = yield* store.latest(source);

  if (latest === null) return yield* new SnapshotError({ message: "No snapshot to export" });
  yield* fs.makeDirectory(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = yield* fs.makeTempFileScoped({ directory: dirname(output), prefix: ".snapshot-export-" });
  yield* fs.chmod(temporary, 0o600);
  yield* store.publish(temporary, {
    html: latest.html, dashboardJson: latest.dashboardJson, dashboardBundle: latest.dashboardBundle,
    publishedAt: latest.publishedAt, keep: 1, shortlist: latest.shortlist, starred: latest.starred,
  });
  yield* fs.link(temporary, output);
})).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot export newest snapshot" })));
