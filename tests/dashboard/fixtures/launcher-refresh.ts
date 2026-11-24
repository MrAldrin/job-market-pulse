import { Effect, Fiber } from "effect";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withInstallationLock } from "../../../src/lib/server/orchestration/workflow-locks.ts";
import { parentPipeKey, watchParentPipe } from "../../../src/lib/server/shared/parent-pipe.ts";

const root = process.env.PULSE_LOCAL_SETTINGS_ROOT;

if (!root) throw new Error("Expected a selected local dashboard");

const marker = (name: string) => join(root, name);

// Match the adapter's second-signal forced exit. No HTTP server, source or model runs here.
let stopping = false;

const deadline = setTimeout(() => process.exit(3), 8_000);

const stop = (signal: string) => {
  appendFileSync(marker("signals"), signal + "\n");

  if (stopping) process.exit(1);
  stopping = true;
  void Effect.runPromise(Fiber.interrupt(refresh)).then(() => clearTimeout(deadline));
};

process.on("SIGINT", () => stop("SIGINT"));

process.on("SIGTERM", () => stop("SIGTERM"));

if (process.env[parentPipeKey] === "1") watchParentPipe(process.stdin, () => stop("pipe closed"));

const refresh = Effect.runFork(withInstallationLock(root, () => Effect.sync(() => writeFileSync(marker("ready"), "")).pipe(
  Effect.zipRight(Effect.never),
  Effect.onInterrupt(() => Effect.gen(function* () {
    yield* Effect.sync(() => writeFileSync(marker("finalizing"), ""));

    while (!existsSync(marker("release"))) yield* Effect.sleep("10 millis");

    yield* Effect.sync(() => writeFileSync(marker("finalized"), ""));
  })),
)).pipe(Effect.tapError(() => Effect.sync(() => process.exit(3)))));
