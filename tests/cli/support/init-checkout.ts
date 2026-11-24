import { CommandExecutor, Terminal } from "@effect/platform";
import { BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import type { CheckoutReport } from "../../../src/cli/checkout-reports.ts";
import type { CheckoutInitRunner } from "../../../src/cli/init-command.ts";
// The public parser factory is not an Effect service constructor.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeCheckoutCli } from "../../../src/cli/pulse.ts";
import { CheckoutRefresh } from "../../../src/cli/pulse-refresh.ts";
import { DashboardLauncher } from "../../../src/lib/server/dashboard/launcher.ts";
import { Schedule } from "../../../src/lib/server/orchestration/schedule.ts";
import { Profile } from "../../../src/lib/server/profile/service.ts";
import { SnapshotJsonFile } from "../../../src/lib/server/snapshot/json-file.ts";
import { SnapshotPaths } from "../../../src/lib/server/snapshot/paths.ts";
import { SnapshotStore } from "../../../src/lib/server/snapshot/store.ts";

const unexpected = () => Effect.dieMessage("Unexpected service in setup CLI proof");

const tripwire = Layer.mergeAll(
  Layer.succeed(Profile, { load: unexpected, inspect: unexpected, setMode: unexpected, cadence: unexpected, readPersonalInputs: unexpected }),
  Layer.succeed(CheckoutRefresh, { run: unexpected }),
  Layer.succeed(CommandExecutor.CommandExecutor, CommandExecutor.makeExecutor(unexpected)),
  Layer.succeed(DashboardLauncher, { start: unexpected }),
  Layer.succeed(Schedule, { install: unexpected, status: unexpected, remove: unexpected, runNow: unexpected }),
  Layer.succeed(SnapshotPaths, { output: unexpected }),
  Layer.succeed(SnapshotJsonFile, { read: unexpected, readOptional: unexpected, write: unexpected }),
  Layer.succeed(SnapshotStore, { publish: unexpected, latest: unexpected, readProfile: unexpected }),
);

export const dispatchSetup = <R>(root: string, args: readonly string[], execute: CheckoutInitRunner<R>) => Effect.gen(function* () {
  let report: CheckoutReport | undefined;

  const dispatch = makeCheckoutCli({ defaultRoot: root, which: () => { throw Error("Unexpected PATH lookup"); } },
    (value) => Effect.sync(() => { report = value; }), execute);

  yield* dispatch(["bun", "pulse.ts", ...args]).pipe(Effect.provide(tripwire), Effect.provide(BunPath.layer));

  return report;
});

export const scriptedTerminal = <E>(ask: Effect.Effect<string, E>) => {
  const writes: string[] = [];
  const asked: string[] = [];

  const terminal = Terminal.Terminal.of({
    display: (text) => Effect.sync(() => { writes.push(text); }),
    readLine: Effect.sync(() => { asked.push(writes.at(-1) ?? ""); }).pipe(
      Effect.zipRight(ask), Effect.mapError(() => new Terminal.QuitException()),
    ),
    columns: Effect.succeed(80), rows: Effect.succeed(24), isTTY: Effect.succeed(false), readInput: unexpected(),
  });

  return { terminal, asked, stdout: () => writes.join("") };
};
