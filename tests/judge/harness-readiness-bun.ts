import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HarnessReadiness, HarnessReadinessLive } from "../../src/lib/server/judge/harness-readiness.ts";
import { probeSupervisorPath, probeTicks, probeUptimeTick, startProbe } from "../../src/lib/server/judge/harness-readiness-supervisor.ts";
import { syntheticPi, syntheticProbePrefix } from "./harness-readiness-fixture.ts";

const [fixture, mode] = process.argv.slice(2);

assert(process.execArgv.includes("--no-env-file"));

assert(fixture && process.env.PATH === fixture);

assert.equal(Bun.version, "1.4.4");

assert.equal(dirname(fixture), realpathSync(tmpdir()));

assert(basename(fixture).startsWith(syntheticProbePrefix));

assert.equal(realpathSync(fixture), fixture);

const owner = process.getuid?.();
const directoryStat = lstatSync(fixture);

assert(directoryStat.isDirectory() && directoryStat.uid === owner && (directoryStat.mode & 0o777) === 0o700);

const executable = join(fixture, "pi");
const executableStat = lstatSync(executable);

assert(executableStat.isFile() && executableStat.nlink === 1 && executableStat.uid === owner && (executableStat.mode & 0o777) === 0o700);

assert(executableStat.size === Buffer.byteLength(syntheticPi));

assert(readFileSync(executable).equals(Buffer.from(syntheticPi)));

assert.equal(Bun.which("pi"), executable);

if (mode !== "ready") {
  assert(mode === "unowned" || mode === "unsafe stdin" || mode === "expired");
  const now = probeUptimeTick();
  const expires = mode === "expired" ? now : now + probeTicks;

  const candidate = spawn(process.execPath, ["--no-env-file", probeSupervisorPath, executable, "invented", "small", String(expires)], {
    cwd: fixture, detached: mode !== "unowned", stdio: [mode === "unsafe stdin" ? "ignore" : "pipe", "ignore", "ignore", "pipe"],
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    candidate.on("error", reject);
    candidate.on("exit", (code, signal) => resolve({ code, signal }));
    candidate.stdin?.on("error", () => {});
    candidate.stdin?.end(startProbe);
  });

  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  process.exit(0);
}

// The checked path is the only valid lookup in this process.
Bun.which = (name) => name === "pi" ? executable : null;

await Effect.runPromise(Effect.gen(function* () {
  const readiness = yield* HarnessReadiness;
  const result = yield* readiness.check({ id: "screen", harness: "pi", provider: "invented", model: "small", effort: "low", batch_size: 1, max_budget_usd: null, timeout_seconds: 1800 });
  const directory = readFileSync(join(fixture, "probe-directory"), "utf8");

  assert.equal(result, executable);
  assert.match(directory, /\/pulse-pi-auth-[^/]+$/);
  assert.equal(existsSync(directory), false);
}).pipe(Effect.provide(HarnessReadinessLive), Effect.provide(BunFileSystem.layer)));
