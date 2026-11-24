import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Fiber, Layer, TestClock, TestContext } from "effect";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessReadiness, harnessReadinessLayer, type ProbeLauncher } from "../../src/lib/server/judge/harness-readiness.ts";
import { ownsProbeSession, probeTicks, readyReceipt, startProbe, superviseProbe } from "../../src/lib/server/judge/harness-readiness-supervisor.ts";
import { ReviewerError } from "../../src/lib/server/judge/reviewer-errors.ts";
import type { Reviewer } from "../../src/lib/server/judge/reviewers.ts";
import { syntheticPi, syntheticProbePrefix } from "./harness-readiness-fixture.ts";

const pi: Reviewer = { id: "screen", harness: "pi", provider: "synthetic", model: "small", effort: "low", batch_size: 10, max_budget_usd: null, timeout_seconds: 1800 };
const claude: Reviewer = { ...pi, id: "judge", harness: "claude-code", provider: "anthropic", model: "synthetic-judge" };
const executable = "/synthetic/bin/pi";
const ready = '{"status":"ready","other":"synthetic"}\n';
const check = (reviewer: Reviewer, launcher: ProbeLauncher, fileSystem = BunFileSystem.layer) => HarnessReadiness.pipe(Effect.flatMap((service) => service.check(reviewer)), Effect.provide(harnessReadinessLayer(launcher)), Effect.provide(fileSystem));
const notReady = Either.left(new ReviewerError({ code: "pi_not_ready" }));
const fakeDirs = new Set<string>();
const bunRuntime = globalThis.Bun;
const nativeWhich = bunRuntime?.which;

const stubLookup = (resolveName: (name: string) => string | null) => {
  const which = vi.fn(resolveName);

  if (bunRuntime) bunRuntime.which = which;
  else vi.stubGlobal("Bun", { which });

  return which;
};

afterEach(() => {
  if (bunRuntime && nativeWhich) bunRuntime.which = nativeWhich;
  vi.unstubAllGlobals();
  vi.useRealTimers();

  for (const path of fakeDirs) rmSync(path, { recursive: true, force: true });
  fakeDirs.clear();
});

it("uses fixed names and never starts a supervisor for Claude or missing Pi", async () => {
  const lookup = stubLookup((name) => name === "claude" ? "/synthetic/bin/claude" : null);
  const launcher = { start: vi.fn(() => { throw new Error("unexpected spawn"); }), now: () => 0n, groupAbsent: vi.fn() };
  await expect(Effect.runPromise(check(claude, launcher))).resolves.toBe("/synthetic/bin/claude");
  await expect(Effect.runPromise(check(pi, launcher).pipe(Effect.flip))).resolves.toEqual(new ReviewerError({ code: "pi_unavailable" }));
  expect(lookup.mock.calls).toEqual([["claude"], ["pi"]]);
  expect(launcher.start).not.toHaveBeenCalled();
});

it("requires the same PID, group and session even for job-control group leaders", () => {
  expect(ownsProbeSession("42 (probe ) sample) R 1 42 42 0", 42)).toBe(true);
  expect(ownsProbeSession("42 (job leader) R 1 42 10 0", 42)).toBe(false);
  expect(ownsProbeSession("42 (shell sibling) R 1 10 10 0", 42)).toBe(false);
});

const supervise = (expires = probeTicks) => {
  const activation = new PassThrough();
  const control = new PassThrough();
  const output = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout });
  const opened = Promise.withResolvers<void>();

  const start = vi.fn(() => {
    opened.resolve();

    return child;
  });

  const stop = vi.fn(() => output.end());
  const refuse = vi.fn(() => output.end());
  let tick = 0n;

  const result = new Promise<string>((resolveResult) => {
    let receipt = "";
    output.on("data", (chunk: Buffer) => { receipt += chunk.toString("utf8"); });
    output.on("end", () => resolveResult(receipt));
  });

  superviseProbe({ activation, control, output, start, now: () => tick, stopOwnGroup: stop, refuseBeforeStart: refuse }, expires);

  return { child, activation, control, stdout, start, stop, refuse, result, opened: opened.promise, setTime: (value: bigint) => { tick = value; } };
};

it.each([
  ["ready", ready, 0, readyReceipt],
  ["login required", '{"status":"login_required","detail":"synthetic diagnostic"}', 0, ""],
  ["diagnostic mixed into stdout", `diagnostic\n${ready}`, 0, ""],
  ["BOM prefix", `\uFEFF${ready}`, 0, ""],
  ["nonzero exit", ready, 2, ""],
  ["exact byte limit", ready.padEnd(64_000), 0, readyReceipt],
  ["oversized output", ready.padEnd(64_001), 0, ""],
] as const)("supervisor returns only a fixed receipt for %s", async (_label, stdout, exit, expected) => {
  const probe = supervise();
  probe.activation.end(startProbe);
  await probe.opened;
  probe.stdout.end(stdout);
  probe.child.emit("exit", exit);

  expect(await probe.result).toBe(expected);
  expect(probe.start).toHaveBeenCalledOnce();
  expect(probe.stop).toHaveBeenCalledOnce();
});

it("supervisor stops its owned group on control EOF, without waiting for Pi exit", async () => {
  const probe = supervise();
  probe.activation.end(startProbe);
  await probe.opened;
  probe.control.end();

  expect(await probe.result).toBe("");
  expect(probe.start).toHaveBeenCalledOnce();
  expect(probe.stop).toHaveBeenCalledOnce();
  expect(probe.stdout.destroyed).toBe(true);
});

it("supervisor deadline is independent of parent control or Pi exit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const probe = supervise();
  probe.activation.end(startProbe);
  await probe.opened;
  vi.advanceTimersByTime(29_999);
  expect(probe.stop).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(probe.stop).toHaveBeenCalledOnce();
});

it.each([
  ["expired entry", 0n], ["overlong budget", probeTicks + 1n], ["delayed activation", probeTicks],
  ["odd byte", probeTicks], ["oversized activation", probeTicks], ["EOF without activation", probeTicks],
] as const)(
  "supervisor neither starts nor signals for %s", async (mode, expires) => {
    const probe = supervise(expires);

    if (mode === "delayed activation") { probe.setTime(probeTicks); probe.activation.end(startProbe); }

    if (mode === "odd byte") probe.activation.end(Buffer.of(0xd3));

    if (mode === "oversized activation") probe.activation.end(startProbe.repeat(2));

    if (mode === "EOF without activation") probe.activation.end();

    expect(await probe.result).toBe("");
    expect(probe.start).not.toHaveBeenCalled();
    expect(probe.stop).not.toHaveBeenCalled();
    expect(probe.refuse).toHaveBeenCalledOnce();
  },
);

it.each(["S", "X"])("supervisor refuses a split extra byte %s before start or signal", async (extra) => {
  const probe = supervise();
  probe.activation.write(startProbe);
  await new Promise<void>((resume) => setImmediate(resume));
  expect(probe.start).not.toHaveBeenCalled();
  expect(probe.stop).not.toHaveBeenCalled();
  probe.activation.end(extra);

  expect(await probe.result).toBe("");
  expect(probe.start).not.toHaveBeenCalled();
  expect(probe.stop).not.toHaveBeenCalled();
  expect(probe.refuse).toHaveBeenCalledOnce();
});

it("supervisor does not start if cancellation arrives before finite activation ends", async () => {
  const probe = supervise();
  probe.activation.write(startProbe);
  probe.control.end();

  expect(await probe.result).toBe("");
  expect(probe.start).not.toHaveBeenCalled();
  expect(probe.stop).not.toHaveBeenCalled();
});

it("supervisor does not issue a ready receipt after the shared deadline", async () => {
  const probe = supervise();
  probe.activation.end(startProbe);
  await probe.opened;
  probe.setTime(probeTicks);
  probe.stdout.end(ready);
  probe.child.emit("exit", 0);

  expect(await probe.result).toBe("");
  expect(probe.stop).toHaveBeenCalledOnce();
});

it("supervisor handles a null child pipe and later spawn error without reporting readiness", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: null });
  const activation = new PassThrough();
  const control = new PassThrough();
  const output = new PassThrough();
  const stopped = Promise.withResolvers<void>();
  const stopOwnGroup = vi.fn(stopped.resolve);
  superviseProbe({ activation, control, output, start: () => child, now: () => 0n, stopOwnGroup, refuseBeforeStart: vi.fn() }, probeTicks);
  activation.end(startProbe);
  await stopped.promise;
  child.emit("error", new Error("synthetic spawn failure"));

  expect(stopOwnGroup).toHaveBeenCalledOnce();
  expect(output.readableLength).toBe(0);
});

const parent = (script: (child: EventEmitter, stdout: PassThrough) => void, absent = true, fileSystem = BunFileSystem.layer, missingPipe = false) => {
  const lookup = stubLookup(() => executable);
  const fakePid = 20_000;
  const groupAbsent = vi.fn(() => absent);
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const control = new PassThrough();

  const child = Object.assign(new EventEmitter(), { pid: missingPipe ? undefined : fakePid, stdin,
    stdout: missingPipe ? null : stdout, stdio: [stdin, stdout, null, control], unref: vi.fn() });

  const started = Promise.withResolvers<void>();
  let cwd = "";

  const start: ProbeLauncher["start"] = (file, reviewer, probeCwd, expires) => {
    expect(file).toBe(executable);
    expect(reviewer).toEqual(pi);
    expect(expires).toBe(probeTicks);
    cwd = probeCwd;
    fakeDirs.add(cwd);
    expect(readdirSync(cwd)).toEqual([]);
    expect(statSync(cwd).mode & 0o077).toBe(0);
    queueMicrotask(() => { script(child, stdout); started.resolve(); });

    return child;
  };

  return {
    run: check(pi, { start, now: () => 0n, groupAbsent }, fileSystem).pipe(Effect.either), started: started.promise, child, stdout,
    assertReleased: (retained: boolean, verified: boolean) => {
      expect(lookup.mock.calls).toEqual([["pi"]]);
      expect(groupAbsent.mock.calls).toEqual(verified ? [[fakePid]] : []);
      expect(child.unref).toHaveBeenCalledOnce();
      expect(stdin.destroyed).toBe(true);
      expect(control.destroyed).toBe(true);
      expect(missingPipe || stdout.destroyed).toBe(true);
      expect(cwd).not.toBe("");
      expect(existsSync(cwd)).toBe(retained);
    },
  };
};

const reportedReady = (child: EventEmitter, stdout: PassThrough) => { stdout.end(readyReceipt); child.emit("exit", null, "SIGKILL"); };

it.each([true, false])("parent trusts the fixed supervisor receipt only with confirmed absence (%s)", async (absent) => {
  const probe = parent(reportedReady, absent);
  expect(await Effect.runPromise(probe.run)).toEqual(absent ? Either.right(executable) : notReady);
  probe.assertReleased(!absent, true);
});

it("parent counts setup time against the shared deadline before spawning", async () => {
  stubLookup(() => executable);
  const now = vi.fn().mockReturnValueOnce(0n).mockReturnValue(probeTicks);
  const start = vi.fn(() => { throw new Error("unexpected spawn"); });
  const groupAbsent = vi.fn(() => false);
  const result = await Effect.runPromise(check(pi, { start, now, groupAbsent }).pipe(Effect.either));

  expect(result).toEqual(notReady);
  expect(start).not.toHaveBeenCalled();
  expect(groupAbsent).not.toHaveBeenCalled();
});

it("removes an empty mkdtemp result that arrives after the caller returns", async () => {
  const preparing = Promise.withResolvers<void>();
  const allowCompletion = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<string>();
  const start = vi.fn(() => { throw new Error("unexpected spawn"); });
  const groupAbsent = vi.fn(() => false);
  stubLookup(() => executable);

  const fs = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (real) => FileSystem.make({
    ...real,
    makeTempDirectory: (options) => Effect.sync(preparing.resolve).pipe(
      Effect.zipRight(Effect.promise(() => allowCompletion.promise)), Effect.zipRight(real.makeTempDirectory(options)),
      Effect.tap((path) => Effect.sync(() => fakeDirs.add(path))),
    ),
    remove: (path, options) => real.remove(path, options).pipe(Effect.tap(() => Effect.sync(() => removed.resolve(path)))),
  }))).pipe(Layer.provide(BunFileSystem.layer));

  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(check(pi, { start, now: () => 0n, groupAbsent }, fs).pipe(Effect.either));
    yield* Effect.promise(() => preparing.promise);
    yield* TestClock.adjust("30 seconds");

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestContext.TestContext)));

  expect(result).toEqual(notReady);
  expect(start).not.toHaveBeenCalled();
  expect(groupAbsent).not.toHaveBeenCalled();
  allowCompletion.resolve();
  expect(existsSync(await removed.promise)).toBe(false);
});

it("parent handles the missing supervisor stream and late error", async () => {
  const probe = parent((child) => { child.emit("error", new Error("synthetic spawn failure")); }, true, BunFileSystem.layer, true);
  expect(await Effect.runPromise(probe.run)).toEqual(notReady);
  probe.assertReleased(false, false);
});

it.each(["stdout stalls", "exit never arrives", "caller interrupts"] as const)("parent closes only its control pipe when %s", async (mode) => {
  const probe = parent((child, stdout) => {
    stdout.write(readyReceipt);

    if (mode === "stdout stalls") child.emit("exit", null, "SIGKILL");
  }, false);

  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(probe.run);
    yield* Effect.promise(() => probe.started);

    if (mode === "caller interrupts") {
      yield* Fiber.interrupt(fiber);

      return notReady;
    }

    yield* TestClock.adjust("20 seconds");

    if (mode === "exit never arrives") probe.stdout.end();
    yield* TestClock.adjust("10 seconds");

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestContext.TestContext)));

  expect(result).toEqual(notReady);
  probe.assertReleased(true, mode === "stdout stalls");
});

it("parent does not add a second wait when verified directory removal stalls", async () => {
  const removing = Promise.withResolvers<void>();

  const fs = Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, (real) => FileSystem.make({
    ...real, remove: () => Effect.sync(() => removing.resolve()).pipe(Effect.zipRight(Effect.never)),
  }))).pipe(Layer.provide(BunFileSystem.layer));

  const probe = parent(() => {}, true, fs);

  const result = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(probe.run);
    yield* Effect.promise(() => probe.started);
    yield* TestClock.adjust("20 seconds");
    reportedReady(probe.child, probe.stdout);
    yield* Effect.promise(() => removing.promise);
    yield* TestClock.adjust("10 seconds");

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestContext.TestContext)));

  expect(result).toEqual(notReady);
  probe.assertReleased(true, true);
});

it.each(["ready", "wrong bytes", "missing startup flag", "unowned", "unsafe stdin", "expired"] as const)("native isolated helper handles %s", (mode) => {
  const candidate = process.env.npm_execpath;

  if (!candidate || !isAbsolute(candidate)) throw new Error("Use the pinned Bun script runner for the native readiness test");
  const bun = realpathSync(candidate);
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), syntheticProbePrefix));
  fakeDirs.add(fixture);
  writeFileSync(join(fixture, "pi"), mode === "wrong bytes" ? '#!/bin/sh\nprintf wrong > "$PATH/unexpected-call"\n' : syntheticPi, { mode: 0o700 });
  const helper = fileURLToPath(new URL("./harness-readiness-bun.ts", import.meta.url));
  const startup = mode === "missing startup flag" ? [] : ["--no-env-file"];
  const result = spawnSync(bun, [...startup, helper, fixture, mode], { cwd: fixture, env: { PATH: fixture }, encoding: "utf8", timeout: 10_000 });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(mode === "wrong bytes" || mode === "missing startup flag" ? 1 : 0);
  expect(existsSync(join(fixture, "invocation-marker"))).toBe(mode === "ready");
  expect(existsSync(join(fixture, "probe-directory"))).toBe(mode === "ready");
  expect(existsSync(join(fixture, "unexpected-call"))).toBe(false);

  if (result.status === 0) expect(result.stderr).toBe("");
});
