import { Command } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Fiber, Layer } from "effect";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dlopen, FFIType, read } from "bun:ffi";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlertProfileLock } from "../../src/lib/server/alert/service.ts";
import { SourceWriterLock } from "../../src/lib/server/source/service.ts";
import { acquirePipelineLocks, acquireWorkflowLock, AlertProfileLockLive, classifyFlockErrno, flockAbi, installationLockPath, localPipelineLockPath, requireInstallationLease, sourceLockPath, SourceWriterLockLive, weeklyLockPath, withInstallationLock, type InstallationLease } from "../../src/lib/server/orchestration/workflow-locks.ts";

const roots: string[] = [];

const root = () => {
  const value = mkdtempSync(join(tmpdir(), "pulse-lock-"));

  roots.push(value);

  return value;
};

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const child = (path: string) => Command.exitCode(Command.make(process.execPath, "tests/orchestration/workflow-locks-child.ts", path)).pipe(Effect.map(Number));
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("workflow locks", () => {
  it("selects only supported native lock bindings without opening a Darwin library", () => {
    for (const arch of ["arm64", "x64"]) {
      expect(flockAbi("darwin", arch)).toEqual({ library: "/usr/lib/libSystem.B.dylib", errnoSymbol: "__error" });
    }

    expect(flockAbi("darwin", "ia32")).toBeNull();
    expect(flockAbi("linux", "arm64")).toBeNull();
    expect(flockAbi("linux", "x64")).toEqual({ library: "libc.so.6", errnoSymbol: "__errno_location" });
    expect(flockAbi("win32", "x64")).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("reads a native non-contention errno instead of reporting every flock error busy", () => {
    const library = dlopen("libc.so.6", {
      flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
      __errno_location: { args: [], returns: FFIType.ptr },
    });

    try {
      expect(library.symbols.flock(-1, 2 | 4)).toBe(-1);
      const address = library.symbols.__errno_location();

      expect(address).not.toBeNull();

      if (!address) throw new Error("errno unavailable");
      const errno = read.i32(address, 0);

      expect(errno).toBe(osConstants.errno.EBADF);
      expect(classifyFlockErrno(errno)).toBe("unavailable");
      expect(classifyFlockErrno(osConstants.errno.EAGAIN)).toBe("busy");
    } finally {
      library.close();
    }
  });
  it("canonicalizes missing sources through symlinks and derives stable run locks", async () => {
    const dir = root(); mkdirSync(join(dir, "real")); symlinkSync("real", join(dir, "alias"));
    expect(await run(sourceLockPath(join(dir, "alias", "missing", "feed.sqlite3")).pipe(Effect.provide(BunContext.layer)))).toBe(join(dir, "real", "missing", ".feed.sqlite3.writer.lock"));
    expect(await run(sourceLockPath(`${dir}/alias/../feed.sqlite3`).pipe(Effect.provide(BunContext.layer)))).toBe(join(dir, ".feed.sqlite3.writer.lock"));
    expect(installationLockPath(dir)).toBe(join(dir, "data", ".local-pipeline-installation.lock"));
    expect(weeklyLockPath(dir, "demo")).toMatch(/\.weekly-[0-9a-f]{16}\.lock$/);
    expect(localPipelineLockPath(dir, "demo")).toMatch(/\.local-pipeline-[0-9a-f]{16}\.lock$/);
  });

  it("excludes another process and independent acquisitions, then releases on success", async () => {
    const path = join(root(), "lock"); writeFileSync(path, "", { mode: 0o666 });

    const result = await run(Effect.scoped(Effect.gen(function* () {
      yield* acquireWorkflowLock(path);
      const same = yield* Effect.either(Effect.scoped(acquireWorkflowLock(path)));
      const other = yield* child(path);

      return { same, other };
    })).pipe(Effect.provide(BunContext.layer)));

    expect(result.same._tag).toBe("Left");

    if (Either.isLeft(result.same)) expect(result.same.left.code).toBe("busy");
    expect(result.other).toBe(75);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await run(child(path).pipe(Effect.provide(BunContext.layer)))).toBe(0);
  });

  it("releases on failure and fiber interruption", async () => {
    const path = join(root(), "lock");
    await run(Effect.either(Effect.scoped(acquireWorkflowLock(path).pipe(Effect.andThen(Effect.fail("failed"))))));
    expect(await run(child(path).pipe(Effect.provide(BunContext.layer)))).toBe(0);
    await run(Effect.gen(function* () {
      const ready = yield* Effect.makeSemaphore(0);
      const fiber = yield* Effect.fork(Effect.scoped(acquireWorkflowLock(path).pipe(Effect.andThen(ready.release(1)), Effect.andThen(Effect.never))));
      yield* ready.take(1);
      expect(yield* child(path)).toBe(75);
      yield* Fiber.interrupt(fiber);
      expect(yield* child(path)).toBe(0);
    }).pipe(Effect.provide(BunContext.layer)));
  });

  it("accepts only an active lease for its root and reuses the held installation lock", async () => {
    const dir = root();
    const other = root();
    let saved: InstallationLease | undefined;

    await run(withInstallationLock(dir, (lease) => Effect.gen(function* () {
      saved = lease;
      expect(yield* child(installationLockPath(dir))).toBe(75);
      const mismatch = yield* Effect.either(requireInstallationLease(other, lease));
      const fake = yield* Effect.either(requireInstallationLease(dir, Object.create(null)));

      expect(Either.isLeft(mismatch)).toBe(true);
      expect(Either.isLeft(fake)).toBe(true);
      const mismatchPipeline = yield* Effect.either(Effect.scoped(acquirePipelineLocks(other, "profile", lease)));

      expect(Either.isLeft(mismatchPipeline)).toBe(true);
      yield* Effect.scoped(Effect.gen(function* () {
        yield* acquirePipelineLocks(dir, "profile", lease);
        expect(yield* child(weeklyLockPath(dir, "profile"))).toBe(75);
        expect(yield* child(localPipelineLockPath(dir, "profile"))).toBe(75);
      }));
      expect(yield* child(weeklyLockPath(dir, "profile"))).toBe(0);
    })).pipe(Effect.provide(BunContext.layer)));

    if (!saved) throw new Error("Lease was not issued");
    expect(Either.isLeft(await run(Effect.either(requireInstallationLease(dir, saved))))).toBe(true);
    expect(Either.isLeft(await run(Effect.either(Effect.scoped(acquirePipelineLocks(dir, "profile", saved)))))).toBe(true);
    expect(await run(child(installationLockPath(dir)).pipe(Effect.provide(BunContext.layer)))).toBe(0);
    await run(Effect.scoped(acquirePipelineLocks(dir, "profile")));
  });

  it("provides real source and alert scoped adapters", async () => {
    const dir = root(); const db = join(dir, "source.sqlite"); const stage = join(dir, ".stage.lock");
    const layers = Layer.merge(SourceWriterLockLive, AlertProfileLockLive);
    await run(Effect.scoped(Effect.gen(function* () {
      yield* (yield* SourceWriterLock).acquire(db);
      yield* (yield* AlertProfileLock).acquire(stage);
      const lockPath = yield* sourceLockPath(db);
      const busy = yield* Effect.either(Effect.scoped((yield* SourceWriterLock).acquire(db)));
      const unavailable = yield* Effect.either(Effect.scoped((yield* SourceWriterLock).acquire("relative.sqlite")));

      expect(Either.isLeft(busy) && busy.left.code).toBe("busy");
      expect(Either.isLeft(unavailable) && unavailable.left.code).toBe("unavailable");
      expect(yield* child(lockPath)).toBe(75);
      expect(yield* child(stage)).toBe(75);
    })).pipe(Effect.provide(layers), Effect.provide(BunContext.layer)));
  });
});
