import { FileSystem } from "@effect/platform";
import { Clock, Effect } from "effect";
import { join, posix, resolve, win32 } from "node:path";
import { serveIdentity } from "../lib/server/dashboard/auth.ts";
import { DashboardError } from "../lib/server/dashboard/errors.ts";
import { DashboardLauncher } from "../lib/server/dashboard/launcher.ts";
import { decodeProfileId, decodeProfileSettings, pathsFor } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { SnapshotJsonFile } from "../lib/server/snapshot/json-file.ts";
import { snapshotJsonBytes } from "../lib/server/snapshot/serialization.ts";
import { withSelected, type CheckoutSelection } from "./checkout-reports.ts";
import { preflightDemo } from "./demo-preflight.ts";
import { demoSnapshot } from "./demo-snapshot.ts";

const launch = (request: Parameters<DashboardLauncher["Type"]["start"]>[0]) => Effect.gen(function* () {
  const code = yield* (yield* DashboardLauncher).start(request);

  return { stdout: "", stderr: code === 0 ? "" : "Dashboard process failed.\n", exitStatus: code === 0 ? 0 : 1 };
}).pipe(Effect.catchTag("DashboardError", (error) => Effect.succeed({ stdout: "", stderr: `${error.message}\n`, exitStatus: 1 })));

export const conflictsWithFeedback = (platform: NodeJS.Platform, feedback: string, paths: readonly string[]): boolean => {
  const path = platform === "win32" ? win32 : posix;
  const files = ["", "-wal", "-shm", "-journal"].map((suffix) => feedback + suffix);

  return paths.some((candidate) => files.some((file) => {
    const remainder = path.relative(file, candidate);

    return remainder !== ".." && !remainder.startsWith(".." + path.sep) && !path.isAbsolute(remainder);
  }));
};

export const dashboard = (
  selection: CheckoutSelection, port: number, explicit: string | null, readOnly: boolean, serveOrigin: string | null = null, serveOwner: string | null = null,
) => {
  const optIn = serveOrigin !== null || serveOwner !== null;
  const serve = serveIdentity(serveOrigin ?? "", serveOwner ?? "");

  if (optIn && (serve === null || explicit !== null || readOnly)) return Effect.succeed({
    stdout: "", stderr: "Tailscale Serve needs a selected writable profile, --serve-origin and --serve-owner.\n", exitStatus: 1,
  });

  if (explicit !== null) return Effect.gen(function* () {
    const snapshot = resolve(explicit);
    const snapshots = yield* SnapshotJsonFile;
    yield* snapshots.read(snapshot);

    return yield* launch({ port, snapshot });
  }).pipe(Effect.catchTag("SnapshotError", () => Effect.succeed({
    stdout: "", stderr: "Cannot read the selected snapshot JSON.\n", exitStatus: 1,
  })));

  return withSelected(selection, (rawRoot, rawId) => Effect.gen(function* () {
    const files = yield* ProfileFiles;
    const root = yield* files.root(rawRoot);
    const id = yield* decodeProfileId(rawId);
    const directory = join(root, "local_only", "profiles", id);
    const snapshot = join(directory, "dashboard-snapshot.json");
    const snapshots = yield* SnapshotJsonFile;
    const exists = yield* files.check(root, snapshot, "File");

    if (exists || readOnly) {
      const document = yield* snapshots.read(snapshot);

      if (document.profile.id !== id) return yield* new DashboardError({ message: "Saved snapshot belongs to another profile." });
    }

    if (readOnly) return yield* launch({ port, snapshot });
    const policy = yield* Effect.flatMap(files.read(root, join(directory, "profile.toml")), decodeProfileSettings);
    const paths = yield* pathsFor(root, id, policy);
    const feedback = join(directory, "shortlist-feedback.sqlite3");
    yield* files.check(root, feedback, "File");

    if (conflictsWithFeedback(process.platform, feedback, Object.values(paths))) {
      return yield* new DashboardError({ message: "Feedback path conflicts with profile settings. Use --read-only or correct the settings." });
    }

    const request = { port, snapshot, feedback: { directory, profileId: id }, localSettings: { root, profileId: id } };

    return yield* launch(serve === null ? request : { ...request, serve });
  }).pipe(Effect.catchAll((error) => Effect.succeed({
    stdout: "", exitStatus: 1,
    stderr: error instanceof DashboardError ? `${error.message}\n` : "Cannot open the selected dashboard. Run pulse refresh or select a valid saved snapshot.\n",
  }))));
};

export const demo = (port: number) => Effect.scoped(Effect.gen(function* () {
  const preflight = yield* preflightDemo;

  if (preflight.kind === "blocked") return preflight;
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-demo-" });
  const snapshot = join(directory, "dashboard-snapshot.json");
  const now = yield* Clock.currentTimeMillis;
  yield* fs.writeFile(snapshot, snapshotJsonBytes(demoSnapshot(preflight.example, now)), { mode: 0o600 });

  return yield* launch({ port, snapshot });
})).pipe(Effect.catchAll(() => Effect.succeed({
  stdout: "", stderr: "Cannot prepare the invented dashboard snapshot.\n", exitStatus: 1,
})));
