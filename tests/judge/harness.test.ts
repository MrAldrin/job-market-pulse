import type { JsonInput } from "../../src/lib/server/shared/json-input.ts";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CommandExecutor } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, HashMap, Inspectable, Layer, Match, Option, Predicate, Sink, Stream, TestClock, TestContext } from "effect";
import type { Reviewer } from "../../src/lib/server/judge/reviewers.ts";
import { ReviewerHarness, ReviewerHarnessLive } from "../../src/lib/server/judge/harness.ts";
import { interpretPi, piArgv } from "../../src/lib/server/judge/harness-pi.ts";
import { claudeArgv, interpretClaude } from "../../src/lib/server/judge/harness-claude.ts";

const reviewer = (harness: Reviewer["harness"]): Reviewer => ({ id: "judge", harness, provider: "synthetic", model: `synthetic-${harness === "pi" ? "pi" : "claude"}-model`, effort: "medium", batch_size: 10, max_budget_usd: null, timeout_seconds: 0.01 });
const fixture = (run: string, name: string) => readFileSync(`tests/oracle/${run}/judge/${name}`);
const bytes = (text: string) => new TextEncoder().encode(text);
const claudeEnvelope = () => ({ type: "result", is_error: false, subtype: "success", modelUsage: { "synthetic-claude-model": {} }, num_turns: 1, permission_denials: [], stop_reason: "end_turn", result: "answer", usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.01 });
const piEnvelope = () => ({ type: "message_end", message: { role: "assistant", model: "synthetic-pi-model", stopReason: "stop", content: [{ type: "text", text: "answer" }], usage: { input: 10, output: 3 } } });
const claude = (value: JsonInput) => interpretClaude(bytes(JSON.stringify(value)), reviewer("claude-code"), 1000);

describe("reviewer harness recordings", () => {
  for (const run of ["basic-run", "resume-run"]) for (const harness of ["pi", "claude"] as const) {
    it(`replays ${run} ${harness} recording`, () => {
      const expected = JSON.parse(fixture(run, `${harness}-parsed.json`).toString());
      const result = harness === "pi" ? interpretPi(fixture(run, "pi-raw.json"), reviewer("pi")) : interpretClaude(fixture(run, "claude-raw.json"), reviewer("claude-code"), 1000);
      const { status, wall_time_seconds: _elapsed, ...recorded } = result;
      expect({ kind: status, ...recorded }).toEqual(expected);
    });
  }
});

describe("harness Claude result mapping", () => {
  it("keeps usage, cost, answer metadata and a dated model ID", () => {
    const value = { ...claudeEnvelope(), modelUsage: { "synthetic-claude-model-20261117": {} } };
    value.result = "æ😀";
    const result = claude(value);
    expect(result).toMatchObject({ status: "result", text: "æ😀", input_tokens: 12, output_tokens: 3, diagnostics: { branch: "received", answer_chars: 2, answer_bytes: 6, cost_usd: 0.01, stop_reason: "end_turn", partial: false } });
  });

  it.each([
    ["provider_unknown", { is_error: true }],
    ["model_mismatch", { modelUsage: { "synthetic-claude-model-preview": {} } }],
    ["model_mismatch", { modelUsage: {} }],
    ["tool_call", { num_turns: 2 }],
    ["tool_call", { permission_denials: ["tool"] }],
    ["non_stop", { stop_reason: "max_tokens" }],
    ["empty_text", { result: "" }],
    ["response_size", { result: "æ".repeat(32769) }],
    ["token_budget", { usage: { output_tokens: 1001 } }],
  ])("preserves %s outcome", (branch, changes) => {
    const result = claude({ ...claudeEnvelope(), ...changes });
    expect(result.diagnostics.branch).toBe(branch);
    expect(result.status).toBe(branch === "provider_unknown" ? "unknown" : "failed");
    expect(result.text).toBeNull();
  });

  it.each(["1.0", "1e0", "true", "-1", "1000001", '"1"'])("does not invent usage for %s", (token) => {
    const raw = JSON.stringify(claudeEnvelope()).replace('"output_tokens":3', `"output_tokens":${token}`);
    expect(interpretClaude(bytes(raw), reviewer("claude-code"), 0).output_tokens).toBeNull();
    const piRaw = JSON.stringify(piEnvelope()).replace('"output":3', `"output":${token}`);
    expect(interpretPi(bytes(piRaw), reviewer("pi"))).toMatchObject({ input_tokens: null, output_tokens: null });
  });

  it("invalidates a sum when one cache count is a float or the sum exceeds the bound", () => {
    const raw = JSON.stringify(claudeEnvelope()).replace('"cache_read_input_tokens":2', '"cache_read_input_tokens":2.0');
    expect(interpretClaude(bytes(raw), reviewer("claude-code"), 1000).input_tokens).toBeNull();
    const value = claudeEnvelope();
    value.usage.input_tokens = 1_000_000;
    expect(claude(value).input_tokens).toBeNull();
  });

  it.each(["null", "[]", "42", '{"type":"other"}', "{broken"]) ("rejects invalid envelope %s", (raw) => {
    expect(interpretClaude(bytes(raw), reviewer("claude-code"), 100)).toMatchObject({ status: "unknown", error_code: "harness_output_invalid" });
    expect(interpretPi(bytes(raw), reviewer("pi"))).toMatchObject({ status: "unknown", error_code: "harness_output_invalid" });
  });

  it("rejects invalid UTF-8 and omits invalid costs", () => {
    expect(interpretClaude(new Uint8Array([255]), reviewer("claude-code"), 100).error_code).toBe("harness_output_invalid");
    expect(claude({ ...claudeEnvelope(), total_cost_usd: -1 }).diagnostics.cost_usd).toBeNull();
  });
});

describe("harness Pi event precedence", () => {
  it.each([
    ["auth network error", "provider_auth"],
    ["expired gateway timeout", "provider_auth"],
    ["network error", "provider_temporary"],
    ["HTTP 503", "provider_temporary"],
    ["code 15030", "provider_unknown"],
    ["unknown problem", "provider_unknown"],
  ])("classifies %s", (errorMessage, branch) => {
    const event = piEnvelope();
    expect(interpretPi(bytes(JSON.stringify({ ...event, message: { ...event.message, stopReason: "error", errorMessage } })), reviewer("pi")).diagnostics.branch).toBe(branch);
  });

  it("uses the last assistant message and retries override an otherwise good answer", () => {
    const raw = JSON.stringify(piEnvelope());
    expect(interpretPi(bytes(`${raw}\n${JSON.stringify({ type: "message_end", message: { role: "user" } })}`), reviewer("pi")).text).toBe("answer");
    expect(interpretPi(bytes(`${raw}\n{"type":"summarization_retry_scheduled"}`), reviewer("pi"))).toMatchObject({ status: "unknown", diagnostics: { branch: "pi_auto_retry", partial: true } });
    expect(interpretPi(bytes(`${raw}\nnull`), reviewer("pi")).diagnostics.branch).toBe("harness_error");
  });
});

describe("harness scoped process adapter", () => {
  for (const harness of ["pi", "claude-code"] as const) for (const mode of ["success", "retry", "overflow", "timeout"] as const) {
    if (harness === "claude-code" && mode === "retry") continue;
    it(`${harness} ${mode}: passes isolated argv/stdin and always cleans up`, async () => {
      let killed = 0;
      let cwd = "";
      const selected = reviewer(harness);
      const deadline = harness === "pi" ? 1800 : selected.timeout_seconds;
      const raw = JSON.stringify(harness === "pi" ? piEnvelope() : claudeEnvelope());

      const stdout = Match.value(mode).pipe(
        Match.when("timeout", () => Stream.never),
        Match.when("overflow", () => Stream.make(new Uint8Array(1_000_001))),
        Match.when("retry", () => Stream.concat(Stream.make(bytes('{"type":"auto_re'), bytes('try_start"}')), Stream.never)),
        Match.orElse(() => Stream.make(bytes(raw))),
      );

      const started = await Effect.runPromise(Deferred.make<void>());

      const executor = CommandExecutor.makeExecutor((command) => Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);

        if (!Predicate.isTagged(command, "StandardCommand")) throw new Error("expected a single command");
        expect([command.command, ...command.args]).toEqual(harness === "pi" ? piArgv("synthetic", selected, "system") : claudeArgv("synthetic", selected, "system"));
        expect(command.args).not.toContain("private prompt");
        expect(command.shell).toBe(false);
        expect(command.args).toEqual(expect.arrayContaining(harness === "pi"
          ? ["--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-context-files", "--offline", "--approve"]
          : ["--tools", "", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--permission-prompts", "none"]));
        cwd = Option.getOrThrow(command.cwd);
        expect(existsSync(cwd)).toBe(true);

        if (harness === "pi") expect(JSON.parse(readFileSync(`${cwd}/.pi/settings.json`, "utf8"))).toEqual({ retry: { enabled: false, provider: { maxRetries: 0 } } });
        else expect(Option.getOrThrow(HashMap.get(command.env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"))).toBe("1000");

        if (command.stdin === "inherit" || command.stdin === "pipe") throw new Error("expected streamed stdin");
        expect(yield* Stream.run(command.stdin.pipe(Stream.decodeText()), Sink.mkString)).toBe("private prompt");

        if (command.stderr === "inherit" || command.stderr === "pipe") throw new Error("stderr must be discarded");
        expect(yield* Stream.run(Stream.make(bytes("ignored private stderr")), command.stderr)).toEqual(new Uint8Array());

        const process: CommandExecutor.Process = {
          [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
          pid: CommandExecutor.ProcessId(123),
          stdout, stderr: Stream.empty, stdin: Sink.drain,
          exitCode: Effect.succeed(CommandExecutor.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: (signal) => Effect.sync(() => { expect(signal).toBe("SIGKILL"); killed++; }),
          toJSON: () => ({}), toString: () => "synthetic process",
          [Inspectable.NodeInspectSymbol]: () => "synthetic process",
        };

        return process;
      }));

      const layer = ReviewerHarnessLive.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Layer.succeed(CommandExecutor.CommandExecutor, executor))));
      const program = Effect.flatMap(ReviewerHarness, (h) => h.call({ executable: "synthetic", reviewer: selected, system_prompt: "system", user_prompt: "private prompt", max_output_tokens: 1000 }));
      // Advance exactly to the deadline so measured wall time cannot include overshoot.

      const result = await Effect.runPromise(Effect.gen(function* () {
        const fiber = yield* Effect.fork(program.pipe(Effect.provide(layer)));
        yield* Deferred.await(started);

        if (mode === "timeout") yield* TestClock.adjust(`${deadline} seconds`);

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)));

      const branches = { success: "received", retry: "pi_auto_retry", overflow: "stream_limit", timeout: "timeout" };
      expect(result.diagnostics.branch).toBe(branches[mode]);
      const statuses = { success: "result", retry: "unknown", overflow: "failed", timeout: "unknown" };
      const errors = { success: null, retry: "harness_call_error", overflow: "model_response_too_large", timeout: "provider_temporary" };
      expect(result.status).toBe(statuses[mode]);
      expect(result.error_code).toBe(errors[mode]);
      expect(result.wall_time_seconds).toBe(mode === "timeout" ? deadline : 0);
      expect(killed).toBe(1);
      expect(existsSync(cwd)).toBe(false);
    });
  }
});
