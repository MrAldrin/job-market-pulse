import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Data, Effect, Layer, Schema } from "effect";
import { AlertError } from "../alert/errors.ts";
import { AlertProfileLock } from "../alert/service.ts";
import { WorkflowError } from "../judge/workflow-errors.ts";
import { ReviewProfileLock } from "../judge/workflow-service.ts";
import { SourceError } from "../source/errors.ts";
import { SourceWriterLock } from "../source/service.ts";
import { containsPath, installedPaths } from "../shared/installation-paths.ts";
import { checkInstalledPath, physicalPath } from "../shared/paths.ts";
import { acquireWindowsLock } from "./windows-file-lock.ts";

export class WorkflowLockError extends Data.TaggedError("WorkflowLockError")<{ readonly code: "busy" | "unavailable" }> {}

export const sourceLockPath = (database: string) => physicalPath(database).pipe(
  Effect.map((path) => join(dirname(path), `.${basename(path)}.writer.lock`)),
);

const identity = (root: string, profileId: string): string => createHash("sha256").update(`${root}\0${profileId}`).digest("hex").slice(0, 16);
export const installationLockPath = (root: string): string => join(root, "data", ".local-pipeline-installation.lock");
export const weeklyLockPath = (root: string, profileId: string): string => join(root, "data", `.weekly-${identity(root, profileId)}.lock`);
export const localPipelineLockPath = (root: string, profileId: string): string => join(root, "data", `.local-pipeline-${identity(root, profileId)}.lock`);

export const flockAbi = (platform: NodeJS.Platform, arch: string) => {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return {
    library: "/usr/lib/libSystem.B.dylib", errnoSymbol: "__error",
  } as const;

  if (platform === "linux" && arch === "x64") return { library: "libc.so.6", errnoSymbol: "__errno_location" } as const;

  return null;
};

const native = () => {
  const abi = flockAbi(process.platform, process.arch);

  if (abi === null) throw new Error("Unsupported flock ABI");

  if (process.platform === "linux") {
    const report = process.report?.getReport();

    if (!Schema.is(Schema.Struct({ header: Schema.Struct({ glibcVersionRuntime: Schema.NonEmptyString }) }))(report)) throw new Error("Unsupported libc");
  }

  // SAFETY: Bun provides this built-in module. Missing libraries or symbols fail closed.
  const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
  const pointer = { args: [], returns: FFIType.ptr } as const;
  const flock = { args: [FFIType.int, FFIType.int], returns: FFIType.int } as const;

  if (abi.errnoSymbol === "__error") {
    const library = dlopen(abi.library, { flock, __error: pointer });

    return { flock: library.symbols.flock, errno: library.symbols.__error, close: () => library.close(), read };
  }

  const library = dlopen(abi.library, { flock, __errno_location: pointer });

  return { flock: library.symbols.flock, errno: library.symbols.__errno_location, close: () => library.close(), read };
};

export const classifyFlockErrno = (errno: number): WorkflowLockError["code"] => errno === osConstants.errno.EAGAIN ? "busy" : "unavailable";

const acquire = (path: string, noFollow: boolean) => {
  if (process.platform === "win32") {
    const result = acquireWindowsLock(path);

    if (result === "busy") throw new WorkflowLockError({ code: "busy" });

    return result;
  }

  const { flock, read, errno, close } = native();
  let fd: number | undefined;

  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (noFollow ? constants.O_NOFOLLOW : 0), 0o600);
    const info = fstatSync(fd);

    if (!info.isFile()) throw new Error("Unsafe lock file");
    fchmodSync(fd, 0o600);

    if (flock(fd, 2 | 4) !== 0) {
      const address = errno();

      if (!address) throw new Error("errno unavailable");
      throw new WorkflowLockError({ code: classifyFlockErrno(read.i32(address, 0)) });
    }

    const lockedFd = fd;

    return () => {
      try {
        if (flock(lockedFd, 8) !== 0) throw new Error("flock unlock failed");
      } finally {
        try { closeSync(lockedFd); } finally { close(); }
      }
    };
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd); } finally { close(); }

    throw error;
  }
};

export const acquireWorkflowLock = (path: string) => {
  const root = installedPaths?.data;
  const installed = root !== undefined && containsPath(root, path);

  const check = installed ? checkInstalledPath(root, path).pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.mapError(() => new WorkflowLockError({ code: "unavailable" })),
  ) : Effect.void;

  return Effect.acquireRelease(
    check.pipe(Effect.zipRight(Effect.try({ try: () => acquire(path, installed), catch: (error) => error instanceof WorkflowLockError ? error : new WorkflowLockError({ code: "unavailable" }) }))),
    (release) => Effect.sync(release),
  ).pipe(Effect.asVoid);
};

const installationLeaseBrand: unique symbol = Symbol("InstallationLease");

export type InstallationLease = { readonly [installationLeaseBrand]: true };

const activeInstallationLeases = new WeakMap<InstallationLease, string>();

export const requireInstallationLease = (root: string, lease: InstallationLease) => Effect.suspend(() =>
  activeInstallationLeases.get(lease) === root
    ? Effect.void
    : Effect.fail(new WorkflowLockError({ code: "unavailable" })),
);

export const withInstallationLock = <A, E, R>(root: string, use: (lease: InstallationLease) => Effect.Effect<A, E, R>) => Effect.scoped(Effect.gen(function* () {
  yield* acquireWorkflowLock(installationLockPath(root));

  const lease = yield* Effect.acquireRelease(Effect.sync(() => {
    const active: InstallationLease = { [installationLeaseBrand]: true };

    activeInstallationLeases.set(active, root);

    return active;
  }), (active) => Effect.sync(() => { activeInstallationLeases.delete(active); }));

  return yield* use(lease);
}));

export const acquirePipelineLocks = (root: string, profileId: string, lease?: InstallationLease) => Effect.gen(function* () {
  if (lease === undefined) yield* acquireWorkflowLock(installationLockPath(root));
  else yield* requireInstallationLease(root, lease);
  yield* acquireWorkflowLock(weeklyLockPath(root, profileId));
  yield* acquireWorkflowLock(localPipelineLockPath(root, profileId));
});

export const SourceWriterLockLive = Layer.effect(SourceWriterLock, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return {
    acquire: (database) => sourceLockPath(database).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(() => new WorkflowLockError({ code: "unavailable" })),
      Effect.flatMap(acquireWorkflowLock),
      Effect.mapError((error) => new SourceError({ message: "Source writer lock unavailable", code: error.code })),
    ),
  };
}));

export const AlertProfileLockLive = Layer.succeed(AlertProfileLock, {
  acquire: (path) => acquireWorkflowLock(resolve(path)).pipe(Effect.mapError((error) => new AlertError({ code: `profile_lock_${error.code}` }))),
});

export const ReviewProfileLockLive = Layer.succeed(ReviewProfileLock, {
  acquire: (path) => acquireWorkflowLock(path).pipe(
    Effect.mapError((error) => new WorkflowError({ code: error.code === "busy" ? "profile_workflow_busy" : "profile_workflow_lock_unavailable" })),
  ),
});
