import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { Clock, Context, Effect, Layer, Sink, Stream } from "effect";
import { join } from "node:path";
import type { Reviewer } from "./reviewers.ts";
import { outcome } from "./harness-errors.ts";
import { interpretPi, piArgv, retryPattern } from "./harness-pi.ts";
import { claudeArgv, interpretClaude } from "./harness-claude.ts";

export interface CallRequest {
  readonly executable: string;
  readonly reviewer: Reviewer;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly max_output_tokens: number;
  readonly singleTurn?: boolean;
}

export interface CallOutcome {
  readonly status: "result" | "failed" | "unknown";
  readonly text: string | null;
  readonly error_code: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly wall_time_seconds: number;
  readonly diagnostics: Readonly<Record<string, string | number | boolean | null>>;
}

export class ReviewerHarness extends Context.Tag("pulse/ReviewerHarness")<ReviewerHarness, {
  readonly call: (request: CallRequest) => Effect.Effect<CallOutcome>;
}>() {}

type StreamFailure = "stream_limit" | "pi_auto_retry" | "timeout";

const streamFailure = (branch: StreamFailure): CallOutcome => branch === "stream_limit"
  ? outcome("failed", "model_response_too_large", branch, true)
  : outcome("unknown", branch === "timeout" ? "provider_temporary" : "harness_call_error", branch, true);

export const ReviewerHarnessLive = Layer.effect(ReviewerHarness, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const executor = yield* CommandExecutor.CommandExecutor;

  return ReviewerHarness.of({ call: (request) => Effect.gen(function* () {
    const started = (yield* Clock.currentTimeMillis);

    const run = Effect.scoped(Effect.gen(function* () {
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-review-" });
      const pi = request.reviewer.harness === "pi";

      if (pi) {
        yield* fs.makeDirectory(join(cwd, ".pi"));
        yield* fs.writeFileString(join(cwd, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
      }

      const argv = pi ? piArgv(request.executable, request.reviewer, request.system_prompt) : claudeArgv(request.executable, request.reviewer, request.system_prompt);

      if (!pi && request.singleTurn) argv.push("--max-turns", "1");

      let command = Command.make(argv[0]!, ...argv.slice(1)).pipe(Command.workingDirectory(cwd), Command.feed(request.user_prompt), Command.stderr(Sink.foldLeft(new Uint8Array(), (empty) => empty)));

      if (!pi) command = Command.env(command, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.max_output_tokens) });
      const process = yield* executor.start(command);
      yield* Effect.addFinalizer(() => process.kill("SIGKILL").pipe(Effect.ignore));
      const chunks: Uint8Array[] = []; let size = 0; let tail = "";
      yield* Stream.runForEach(process.stdout, (chunk) => Effect.gen(function* () {
        size += chunk.length;

        if (size > 1_000_000) return yield* Effect.fail("stream_limit" as const);
        chunks.push(chunk);

        if (pi) {
          const window = tail + new TextDecoder("latin1").decode(chunk);

          if (retryPattern.test(window)) return yield* Effect.fail("pi_auto_retry" as const);
          tail = window.slice(-128);
        }
      }));
      yield* process.exitCode;
      const bytes = new Uint8Array(size); let offset = 0;

      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }

      return pi ? interpretPi(bytes, request.reviewer) : interpretClaude(bytes, request.reviewer, request.max_output_tokens);
    })).pipe(Effect.timeoutFail({ duration: `${request.reviewer.harness === "pi" ? 1800 : request.reviewer.timeout_seconds} seconds`, onTimeout: () => "timeout" as const }), Effect.catchAll((error) => Effect.succeed(error === "stream_limit" || error === "pi_auto_retry" || error === "timeout" ? streamFailure(error) : outcome("unknown", "harness_call_error", "harness_error"))));

    const result = yield* run;

    return { ...result, wall_time_seconds: Math.max(0, ((yield* Clock.currentTimeMillis) - started) / 1000) };
  }) });
}));
