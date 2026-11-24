import { FileSystem } from "@effect/platform";
import { Clock, Context, Deferred, Duration, Effect, Layer, Predicate } from "effect";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import packageInfo from "../../../../package.json" with { type: "json" };
import { Writable, type Readable } from "node:stream";
import { cancelFd, probeSeconds, probeSupervisorPath, probeTicks, probeUptimeTick, readyReceipt, startProbe } from "./harness-readiness-supervisor.ts";
import { harnessExecutables } from "./reviewer-detect.ts";
import { ReviewerError } from "./reviewer-errors.ts";
import { installedPaths } from "../shared/installation-paths.ts";
import type { Reviewer } from "./reviewers.ts";

export class HarnessReadiness extends Context.Tag("pulse/HarnessReadiness")<HarnessReadiness, {
  readonly check: (reviewer: Reviewer) => Effect.Effect<string, ReviewerError>;
}>() {}

const deadlineNanos = BigInt(probeSeconds) * 1_000_000_000n;
const piNotReady = () => new ReviewerError({ code: "pi_not_ready" });

type TempProbeDirectory = { readonly path: string; removable: boolean };

interface DirectoryAllocation {
  closed: boolean;
  directory?: TempProbeDirectory;
}

export interface ProbeProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stdio: readonly (Readable | Writable | null | undefined)[];
  readonly unref: () => void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: () => void): void;
}

export interface ProbeLauncher {
  readonly start: (executable: string, reviewer: Reviewer, cwd: string, expires: bigint) => ProbeProcess;
  readonly now: () => bigint;
  readonly groupAbsent: (pid: number) => boolean;
}

const nativeLauncher: ProbeLauncher = {
  now: probeUptimeTick,
  start: (executable, reviewer, cwd, expires) => {
    if (!isAbsolute(process.execPath) || packageInfo.packageManager !== `bun@${Bun.version}`) throw piNotReady();

    const resources = installedPaths?.resources;
    const runtime = resources === undefined ? process.execPath : join(resources, "pulse");
    const script = resources === undefined ? probeSupervisorPath : join(resources, "pulse-probe.mjs");

    // The compiled CLI can run the bundled helper as Bun. Keep its guarded
    // entry point and --no-env-file check the same as in the checkout.
    return spawn(runtime, ["--no-env-file", script, executable, reviewer.provider, reviewer.model, String(expires)], {
      env: resources === undefined ? process.env : { ...process.env, BUN_BE_BUN: "1" },
      cwd, detached: true, shell: false, stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
  },
  groupAbsent: (pid) => {
    // Signal 0 checks existence only. This parent never sends a destructive signal.
    try { process.kill(-pid, 0); }
    catch (cause) { return Predicate.isRecord(cause) && cause["code"] === "ESRCH"; }

    return false;
  },
};

const probe = (launcher: ProbeLauncher, executable: string, reviewer: Reviewer, cwd: TempProbeDirectory, expires: bigint) => Effect.async<void, ReviewerError>((resume) => {
  const beforeExpiry = () => {
    try { return launcher.now() < expires; }
    catch { return false; }
  };

  if (!beforeExpiry()) return resume(Effect.fail(piNotReady()));

  const child = launcher.start(executable, reviewer, cwd.path, expires);
  const { pid, stdin, stdout } = child;
  const extra = child.stdio[cancelFd];
  const control = extra instanceof Writable ? extra : null;
  let stopped = false;
  let exited = false;
  let eof = false;
  let reported = false;
  cwd.removable = pid === undefined;

  const dispose = () => {
    if (stopped) return;
    stopped = true;
    cwd.removable = pid === undefined || (pid > 0 && exited && launcher.groupAbsent(pid));
    control?.destroy(); // Only cancellation EOF tells the supervisor to stop.
    stdin?.destroy();
    stdout?.destroy();
    child.unref();
  };

  const finish = (ready: boolean) => {
    if (stopped) return;
    dispose();
    resume(ready && pid !== undefined && pid > 0 && cwd.removable && beforeExpiry() ? Effect.void : Effect.fail(piNotReady()));
  };

  child.on("error", () => finish(false));
  stdin?.on("error", () => finish(false));
  control?.on("error", () => finish(false));
  stdout?.on("error", () => finish(false));

  if (stdin === null || stdout === null || control === null) return finish(false);

  stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;

    if (reported || chunk.length !== 1 || chunk.toString("ascii") !== readyReceipt) finish(false);
    else reported = true;
  });
  stdout.on("end", () => {
    eof = true;

    if (exited) finish(reported);
  });
  child.on("exit", (code, signal) => {
    exited = true;

    if (code !== null || signal !== "SIGKILL") finish(false);
    else if (eof) finish(reported);
  });
  stdin.end(startProbe);

  return Effect.sync(dispose);
});

const privateDirectory = (fs: FileSystem.FileSystem, expires: bigint) => Effect.gen(function* () {
  const ready = yield* Deferred.make<TempProbeDirectory, ReviewerError>();
  const allocation: DirectoryAllocation = { closed: false };
  const remove = (path: string) => fs.remove(path, { recursive: true, force: true });
  const discard = (path: string) => remove(path).pipe(Effect.ignore, Effect.catchAllDefect(() => Effect.void));

  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    allocation.closed = true;
    const { directory } = allocation;

    if (!directory?.removable) return;
    const remaining = expires - (yield* Clock.currentTimeNanos);

    if (remaining <= 0n) {
      yield* Effect.forkDaemon(discard(directory.path));

      return yield* Effect.die(piNotReady());
    }

    yield* remove(directory.path).pipe(
      Effect.interruptible, Effect.timeoutFail({ duration: Duration.nanos(remaining), onTimeout: piNotReady }), Effect.mapError(piNotReady), Effect.orDie,
    );
  }));

  // mkdtemp cannot retract its callback. This short-lived owner either hands
  // the path to the active scope or removes it after that scope has returned.
  yield* fs.makeTempDirectory({ prefix: "pulse-pi-auth-" }).pipe(
    Effect.matchCauseEffect({
      onFailure: () => Deferred.fail(ready, piNotReady()),
      onSuccess: (path) => Effect.suspend(() => {
        if (allocation.closed) return discard(path).pipe(Effect.as(false));
        const directory = { path, removable: true };
        allocation.directory = directory;

        return Deferred.succeed(ready, directory);
      }),
    }),
    Effect.forkDaemon,
  );

  return yield* Deferred.await(ready);
});

const checkPi = (fs: FileSystem.FileSystem, launcher: ProbeLauncher, executable: string, reviewer: Reviewer) => Effect.gen(function* () {
  const expires = (yield* Clock.currentTimeNanos) + deadlineNanos;
  const sharedExpiry = (yield* Effect.sync(launcher.now)) + probeTicks;
  const cwd = yield* privateDirectory(fs, expires);

  yield* probe(launcher, executable, reviewer, cwd, sharedExpiry);
}).pipe(
  Effect.scoped, Effect.timeoutFail({ duration: Duration.nanos(deadlineNanos), onTimeout: piNotReady }),
  Effect.mapError(piNotReady), Effect.catchAllDefect(() => piNotReady()),
);

export const harnessReadinessLayer = (launcher: ProbeLauncher) => Layer.effect(HarnessReadiness, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return HarnessReadiness.of({ check: (reviewer) => Effect.gen(function* () {
    const name = harnessExecutables[reviewer.harness];
    const unavailable = () => new ReviewerError({ code: `${name}_unavailable` });
    const windows = process.platform === "win32";

    if (windows && reviewer.harness === "pi") return yield* new ReviewerError({ code: "pi_requires_linux_probe" });
    const executable = yield* Effect.try({ try: () => Bun.which(windows ? `${name}.exe` : name), catch: unavailable });

    if (executable === null) return yield* unavailable();

    if (reviewer.harness === "pi") yield* checkPi(fs, launcher, executable, reviewer);

    return executable;
  }) });
}));

export const HarnessReadinessLive = harnessReadinessLayer(nativeLauncher);
