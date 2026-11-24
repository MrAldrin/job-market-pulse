#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit } from "effect";
import { runLocalPipeline } from "../lib/server/orchestration/local-pipeline.ts";
import { AppLive } from "../lib/server/runtime.ts";

let exitCode = 0;

const command = Command.make("run-local-pipeline", {
  root: Options.text("root"),
  profile: Options.text("profile"),
  once: Options.boolean("once"),
  reset: Options.boolean("reset"),
}, ({ root, profile, once, reset }) => Effect.gen(function* () {
  const output = yield* runLocalPipeline({ root, profileId: profile, once, reset });
  exitCode = output.exitCode;

  for (const warning of output.warnings) yield* Console.error(warning);

  if (output.status === "completed" && output.run_id !== null) yield* Console.log(`Run ${output.run_id} completed.`);
  yield* Console.log(`Run summary: ${JSON.stringify({ status: output.status, profile_id: profile, run_id: output.run_id, stage: output.stage, next_attempt_at: output.next_attempt_at })}`);
}));

const run = Command.run(command, { name: "Job Market Pulse local pipeline", version: "0.0.0" });

run(process.argv).pipe(Effect.provide(AppLive), BunRuntime.runMain({
  disableErrorReporting: true,
  teardown: (exit, end) => end(Exit.isSuccess(exit) ? exitCode : Cause.isInterruptedOnly(exit.cause) ? 130 : 2),
}));
