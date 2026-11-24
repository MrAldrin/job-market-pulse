import { Effect, Either } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSnapshotBytes } from "../lib/contracts/snapshot.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { readBoundedFile } from "../lib/server/shared/bounded-file.ts";
import { installedExecutable, installedPaths } from "../lib/server/shared/installation-paths.ts";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const failure = (message: string) => ({ kind: "blocked", exitStatus: 1, stdout: "", stderr: `${message}\n` } as const);
const noBuild = failure("The dashboard is not built. Run from the checkout root: bun run build");
const missingSnapshot = failure("The invented-job fixture is missing from this checkout.");
const unsafeSnapshot = failure("Cannot read the invented-job fixture safely.");
const invalidSnapshot = failure("The invented-job fixture does not pass the snapshot contract.");

// Demo reads only shipped resources, not a selected profile or snapshot.
// This does not load the dashboard program or allocate demo state.
export const preflightDemo = Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const root = yield* files.root(installedPaths?.resources ?? checkout).pipe(Effect.orElseSucceed(() => null));
  const noDashboard = installedPaths === null ? noBuild : failure("Bundled dashboard is missing.");

  if (root === null) return noDashboard;
  const buildEntry = join(root, installedPaths === null ? "build/index.js" : installedExecutable("pulse-dashboard"));

  if (!(yield* files.check(root, buildEntry, "File").pipe(Effect.orElseSucceed(() => false)))) return noDashboard;
  const snapshotPath = join(root, "contracts", "fixtures", "snapshot.example.json");
  const snapshot = yield* Effect.either(files.check(root, snapshotPath, "File"));

  if (Either.isLeft(snapshot)) return unsafeSnapshot;

  if (!snapshot.right) return missingSnapshot;

  const bytes = yield* readBoundedFile(snapshotPath, 8_000_000).pipe(Effect.orElseSucceed(() => null));

  if (bytes === null) return unsafeSnapshot;

  const example = decodeSnapshotBytes(bytes);

  return Either.isLeft(example) ? invalidSnapshot : { kind: "validated", example: example.right } as const;
});
