import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCheckoutBuild, type CheckoutBuild } from "../lib/server/dashboard/checkout-build.ts";
import { ntfyTopicPresent } from "../lib/server/profile/ntfy-settings.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { installedPaths } from "../lib/server/shared/installation-paths.ts";
import { isCanonicalPath } from "../lib/server/shared/paths.ts";
import { readNodeVersion } from "./checkout-toolchain.ts";
import { relativeInitPath } from "./init-state.ts";

export interface DoctorHost {
  readonly platform: NodeJS.Platform;
  readonly bunVersion: string;
  readonly checkoutNode: Effect.Effect<string | null> | null;
  readonly uid: number | undefined;
  readonly which: (name: string) => string | null;
  readonly commandOk: (executable: string, args: readonly string[]) => Effect.Effect<boolean>;
  readonly canWrite: (root: string, directory: string) => Effect.Effect<boolean, never, FileSystem.FileSystem | ProfileFiles>;
  readonly dashboardBuild: Effect.Effect<CheckoutBuild | null>;
  readonly hasNtfyTopic: (root: string) => Effect.Effect<boolean, never, FileSystem.FileSystem | ProfileFiles>;
}

const safeDataPath = (root: string, path: string) => Effect.gen(function* () {
  if (path !== root) {
    const name = yield* relativeInitPath(root, path);

    // Ignore case here as the filesystem can also ignore case on macOS.
    if (name.toLowerCase().split(sep).some((part) => part === ".git" || part === ".jj")) return false;
  }

  return yield* isCanonicalPath(path);
});

export const databasePathState = (root: string, path: string) => Effect.gen(function* () {
  if (!(yield* safeDataPath(root, path))) return "invalid" as const;
  const files = yield* ProfileFiles;

  // An absent database is fine. A directory, alias or unsafe parent is not.
  return (yield* files.check(root, path, "File")) ? "present" as const : "pending" as const;
}).pipe(Effect.orElseSucceed(() => "invalid" as const));

export const probeDataDirectory: DoctorHost["canWrite"] = (root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* ProfileFiles;
  let existing = directory;

  if (!(yield* safeDataPath(root, directory))) return false;

  // A first run may create data directories. Test the nearest existing parent,
  // but do not fall back when validation finds an unsafe path or the wrong kind.
  while (true) {
    if (yield* files.check(root, existing, "Directory")) break;

    if (existing === root) return false;
    existing = dirname(existing);
  }

  // Test actual creation, including Windows ACLs. Do not touch existing files.
  yield* fs.makeTempFileScoped({ directory: existing, prefix: ".pulse-doctor-" });

  return true;
}).pipe(Effect.scoped, Effect.orElseSucceed(() => false));

export const nativeDoctorHost = (which: DoctorHost["which"]): DoctorHost => ({
  platform: process.platform,
  uid: process.getuid?.(),
  bunVersion: Bun.version,
  checkoutNode: installedPaths === null ? Effect.promise(() => readNodeVersion(which("node"))) : null,
  which,
  commandOk: (executable, args) => Effect.tryPromise({
    try: async (signal) => await Bun.spawn([executable, ...args], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 3_000, killSignal: "SIGKILL", signal,
    }).exited === 0,
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false)),
  dashboardBuild: Effect.promise(() => installedPaths === null
    ? inspectCheckoutBuild(fileURLToPath(new URL("../../", import.meta.url))) : Promise.resolve(null)),
  canWrite: probeDataDirectory,
  hasNtfyTopic: ntfyTopicPresent,
});
