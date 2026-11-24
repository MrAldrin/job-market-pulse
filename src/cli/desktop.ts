import { Effect, Option } from "effect";
import { fileURLToPath } from "node:url";
import type { CheckoutSelection } from "./checkout-reports.ts";

const executable = fileURLToPath(new URL("../../node_modules/electron/dist/electron", import.meta.url));
const entry = fileURLToPath(new URL("../../desktop/main.mjs", import.meta.url));

export const prepareDesktop = Effect.tryPromise(async (signal) => await Bun.spawn(
  [process.execPath, "--no-env-file", "run", "setup:desktop"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdin: "ignore", stdout: "inherit", stderr: "inherit", signal,
  },
).exited === 0).pipe(Effect.orElseSucceed(() => false));

export const desktop = (selection: CheckoutSelection, snapshot: Option.Option<string>, readOnly: boolean) => Effect.scoped(Effect.gen(function* () {
  const report = (exitStatus: number, stderr = "") => ({ stdout: "", stderr, exitStatus });

  if (process.platform !== "linux") return report(1, "Pulse desktop supports Linux only.\n");

  // Do not use Electron's npm launcher: it downloads the runtime if missing.
  if (!(yield* Effect.promise(() => Bun.file(executable).exists()))) return report(1, "Electron is missing. Run bun run setup:desktop from the checkout.\n");
  const args = ["--root", selection.root];

  if (selection.explicit !== undefined) args.push("--profile", selection.explicit);
  args.push("dashboard");

  if (Option.isSome(snapshot)) args.push("--snapshot", snapshot.value);

  if (readOnly) args.push("--read-only");
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;

  const env = {
    ...parentEnv, PULSE_DESKTOP_BUN: process.execPath,
    PULSE_DESKTOP_READ_ONLY: readOnly || Option.isSome(snapshot) ? "1" : "0",
  };

  const child = yield* Effect.acquireRelease(Effect.try({
    try: () => Bun.spawn([executable, entry, ...args], { cwd: process.cwd(), env, detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" }),
    catch: () => "Cannot start Electron.\n",
  }), (child) => Effect.gen(function* () {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    yield* Effect.promise(() => child.exited);
  }));

  const code = yield* Effect.promise(() => child.exited);

  return code === 0 && child.signalCode === null ? report(0) : report(1, "Pulse desktop stopped with an error.\n");
})).pipe(Effect.catchAll((message) => Effect.succeed({ stdout: "", stderr: message, exitStatus: 1 })));
