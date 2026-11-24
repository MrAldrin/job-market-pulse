import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { Context, Data, Effect, Layer, Option, Predicate, Schema, Sink, Stream } from "effect";
import { PiModelCatalog } from "../../contracts/local-settings.ts";
import { ModelLabel, ProviderLabel, reviewerEfforts } from "../../contracts/reviewer-settings.ts";
import { ReviewerHarness } from "./harness.ts";
import { harnessExecutables } from "./reviewer-detect.ts";
import type { Reviewer } from "./reviewers.ts";

export class ModelPickerError extends Data.TaggedError("ModelPickerError")<{
  readonly code: "pi_missing" | "discovery_failed" | "harness_missing" | "test_timeout" | "test_failed" | "wrong_reply";
}> {}

const error = (code: ModelPickerError["code"]) => new ModelPickerError({ code });
const requestId = "pulse-model-catalog";
const listCommand = "get_available_models";
const isProvider = Schema.is(ProviderLabel);
const isModel = Schema.is(ModelLabel);

// RPC also reports unrelated events and provider metadata. Keep only the
// selection labels and levels that the existing file format can represent.
function readCatalog(line: string): PiModelCatalog | undefined {
  const reply: unknown = JSON.parse(line);

  if (!Predicate.isRecord(reply) || reply.type !== "response" || reply.id !== requestId) return undefined;

  if (reply.command !== listCommand || reply.success !== true || !Predicate.isRecord(reply.data) || !Array.isArray(reply.data.models)) {
    throw error("discovery_failed");
  }

  const models = new Map<string, PiModelCatalog[number]>();

  for (const model of reply.data.models) {
    if (!Predicate.isRecord(model) || !isProvider(model.provider) || !isModel(model.id)) continue;

    const map = Predicate.isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};

    const efforts = model.reasoning === true ? reviewerEfforts.filter((level) =>
      map[level] !== null && ((level !== "xhigh" && level !== "max") || map[level] !== undefined),
    ) : [];

    models.set(`${model.provider}/${model.id}`, { provider: model.provider, model: model.id, efforts });
  }

  return Schema.decodeUnknownSync(PiModelCatalog)([...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, model]) => model));
}

export class JudgeModelPicker extends Context.Tag("pulse/JudgeModelPicker")<JudgeModelPicker, {
  readonly discoverPi: Effect.Effect<PiModelCatalog, ModelPickerError>;
  readonly test: (reviewer: Reviewer) => Effect.Effect<void, ModelPickerError>;
}>() {}

export const JudgeModelPickerLive = Layer.effect(JudgeModelPicker, Effect.gen(function* () {
  const executor = yield* CommandExecutor.CommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const harness = yield* ReviewerHarness;

  const discoverPi = Effect.scoped(Effect.gen(function* () {
    const executable = Bun.which(harnessExecutables.pi);

    if (!executable) return yield* error("pi_missing");
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-models-" });
    const input = JSON.stringify({ id: requestId, type: listCommand }) + "\n";

    // RPC needs stdin open until it sends the reply. Closing it can shut down Pi first.
    const stdin = Stream.concat(Stream.succeed(new TextEncoder().encode(input)), Stream.never);

    const command = Command.make(executable, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline").pipe(
      Command.workingDirectory(cwd), Command.stdin(stdin), Command.stderr(Sink.foldLeft(new Uint8Array(), (empty) => empty)),
    );

    const child = yield* executor.start(command);
    yield* Effect.addFinalizer(() => child.kill("SIGKILL").pipe(Effect.ignore));
    let size = 0;

    const catalog = yield* child.stdout.pipe(
      Stream.tap((chunk) => {
        size += chunk.length;

        return size <= 4_000_000 ? Effect.void : Effect.fail(error("discovery_failed"));
      }),
      Stream.decodeText(), Stream.splitLines,
      Stream.mapEffect((line) => Effect.try({ try: () => readCatalog(line), catch: () => error("discovery_failed") })),
      Stream.filter((value): value is PiModelCatalog => value !== undefined),
      Stream.runHead,
    );

    if (Option.isNone(catalog)) return yield* error("discovery_failed");

    return catalog.value;
  })).pipe(
    Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => error("discovery_failed") }),
    Effect.mapError((cause) => cause instanceof ModelPickerError ? cause : error("discovery_failed")),
  );

  return {
    discoverPi,
    test: (reviewer) => Effect.gen(function* () {
      const executable = Bun.which(harnessExecutables[reviewer.harness]);

      if (!executable) return yield* error("harness_missing");

      const result = yield* harness.call({ executable, reviewer, singleTurn: true, max_output_tokens: 1024,
        system_prompt: "This is a connection test. Reply with exactly OK.", user_prompt: "Reply with OK." }).pipe(
        Effect.timeoutFail({ duration: "60 seconds", onTimeout: () => error("test_timeout") }),
      );

      if (result.status !== "result") return yield* error("test_failed");

      if (result.text?.trim() !== "OK") return yield* error("wrong_reply");
    }),
  };
}));
