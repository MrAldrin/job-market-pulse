import { Effect, Either, Predicate } from "effect";
import type { TomlValue } from "smol-toml";
import { classifyModelListing, helpArgv, listModelsArgv, parseAdvertisedEfforts, runStdoutLimit, type DetectedHarness, type Harness } from "../lib/server/judge/reviewer-detect.ts";
import { decodeModelSettings, modelSteps, type ModelStep, type Reviewer } from "../lib/server/judge/reviewers.ts";
import { askInitText, InitInputError, InitMissingAnswer, type InitQuestions } from "./init-prompts.ts";
import type { InterviewIO } from "./interview-session.ts";

type SetupHarness = DetectedHarness & { readonly isFile: boolean };

type InstalledHarness = SetupHarness & { readonly executable: string };

type Metadata = { readonly kind: "ok"; readonly text: string } | { readonly kind: "empty" | "timeout" | "cap" | "error" };

export interface SetupModelServices<R> {
  readonly dryRun: boolean;
  readonly detect: () => Effect.Effect<readonly SetupHarness[], unknown, R>;
  // Null means metadata is unavailable. An injected probe must enforce
  // Judge's runTimeoutSeconds and runStdoutLimit.
  readonly query: ((argv: readonly string[]) => Effect.Effect<Metadata, unknown, R>) | null;
}

const names = { "claude-code": "Claude Code", pi: "Pi" } as const;
const fields = ["harness", "model", "effort", "batch_size"] as const;
const commonKeys = ["ai_program", "ai_model", "ai_effort"] as const;
const stageKeys = modelSteps.flatMap((stage) => fields.map((field) => `${stage}_${field}`));
const batchDefaults = { screen: 20n, judge: 5n, rejudge: 5n, calibrate: 1n };
const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const invalidProgram = "Choose an installed program or its number.";
const invalidModel = "Use provider/model-id for Pi, or an unqualified model ID for Claude Code.";
const invalidSetup = "Choose a number or key.";
const inputError = (message: string) => new InitInputError({ message });

type StageValues = Record<typeof fields[number], TomlValue | undefined>;

type StageEntry = { harness: string; model: string; effort: string; batch_size: bigint };

const line = (stage: ModelStep, row: StageEntry): string =>
  `"${stage}" = { "harness" = ${JSON.stringify(row.harness)}, "model" = ${JSON.stringify(row.model)}, "effort" = ${JSON.stringify(row.effort)}, "batch_size" = ${row.batch_size} }\n`;

// The owning decoder takes a complete document. Use the candidate identity in
// every row, with a neutral batch size outside the stage being validated.
const decodeStage = (stage: ModelStep, row: StageEntry) => Either.map(
  decodeModelSettings(modelSteps.map((key) => line(key, key === stage ? row : { ...row, batch_size: 1n })).join("")),
  (models) => models[stage],
);

const savedStage = (model: Reviewer): StageEntry => ({
  harness: model.harness,
  model: model.harness === "pi" ? `${model.provider}/${model.model}` : model.model,
  effort: model.effort,
  batch_size: BigInt(model.batch_size),
});

const suppliedRecovery = (ctx: InitQuestions, key: string): boolean =>
  ctx.inputChanged(key) && ctx.recoveredKeys.has(key) && !ctx.explicitKeys.has(key);

const validatedNamedText = (ctx: InitQuestions, key: string, validate: (text: string) => string | null) => {
  const value = ctx.current(key);

  if (!Predicate.isString(value)) return Effect.fail(inputError(`Answer ${key} must be text.`));
  const error = validate(value);

  return error ? Effect.fail(inputError(error)) : Effect.succeed(value);
};

const selectText = (ctx: InitQuestions, key: string, prompt: string, fallback: string | undefined, validate: (text: string) => string | null) =>
  suppliedRecovery(ctx, key) ? validatedNamedText(ctx, key, validate) : ctx.answer(key, { prompt, default: fallback, validate });

const aliases = (installed: readonly InstalledHarness[]) => new Map(installed.flatMap(({ harness }, index) => [
  [String(index + 1), harness], [harness, harness], [names[harness], harness],
]));

const chooseProgram = (ctx: InitQuestions, key: string, installed: readonly InstalledHarness[], fallback: Harness) => Effect.gen(function* () {
  const choices = aliases(installed);

  for (const [index, item] of installed.entries()) yield* ctx.say(`${index + 1}. ${names[item.harness]}`);
  const selected = yield* selectText(ctx, key, "AI program", fallback, (value) => choices.has(value) ? null : invalidProgram);
  const harness = choices.get(selected);

  if (!harness) return yield* inputError(invalidProgram);
  ctx.answers[key] = harness;

  return harness;
});

const query = <R>(probe: NonNullable<SetupModelServices<R>["query"]>, argv: readonly string[]) =>
  Effect.suspend(() => probe(argv)).pipe(
    Effect.map((result): Metadata => result.kind === "ok" && Buffer.byteLength(result.text, "utf8") > runStdoutLimit ? { kind: "cap" } : result),
    Effect.catchAll(() => Effect.succeed<Metadata>({ kind: "error" })),
  );

const chooseModel = <R>(ctx: InitQuestions, io: InterviewIO, key: string, program: InstalledHarness, fallback: string | undefined, services: SetupModelServices<R>, useStoredAnswer = true) => Effect.gen(function* () {
  const choices = new Map<string, string>();
  const { harness, executable, isFile } = program;

  if (!useStoredAnswer || !ctx.inputChanged(key)) {
    if (services.dryRun) yield* ctx.say("This dry run does not list models. Type the model name. Access is not checked.");
    else if (services.query === null) yield* ctx.say("Model metadata is unavailable in this checkout. Type the model name. Access is not checked.");
    else if (harness === "claude-code") yield* ctx.say("Claude Code has no read-only model list in this version. Type the model name. Access is not checked.");
    else if (isFile && !ctx.nonInteractive) {
      const result = yield* query(services.query, listModelsArgv(executable));
      const [kind, models] = result.kind === "ok" ? classifyModelListing(result.text) : [result.kind, []] as const;

      if (kind === "ok") {
        for (const [index, model] of models.entries()) {
          choices.set(String(index + 1), model);
          yield* ctx.say(`${index + 1}. ${model}`);
        }

        yield* ctx.say("Choose a listed model or type a provider/model-id. Access is not checked.");
      } else if (kind === "empty" || kind === "no-rows") {
        yield* ctx.say("Pi returned no models. Type a provider/model-id. A typed name is not an access check.");
      } else yield* ctx.say("Pi model list failed. Type a provider/model-id. Access is not checked.");
    }
  }

  const validate = (value: string) => Either.isRight(decodeStage("judge", {
    harness, model: choices.get(value) ?? value, effort: "medium", batch_size: 1n,
  })) ? null : invalidModel;

  const named = useStoredAnswer && (ctx.explicitKeys.has(key) || suppliedRecovery(ctx, key));

  const selected = yield* (services.query !== null || named ? selectText(ctx, key, "Model", fallback, validate)
    : ctx.nonInteractive ? Effect.fail(new InitMissingAnswer({ key })) : askInitText(io, { prompt: "Model", default: fallback, validate }));

  const model = choices.get(selected) ?? selected;
  ctx.answers[key] = model;

  return model;
});

const chooseEffort = <R>(ctx: InitQuestions, io: InterviewIO, key: string, program: InstalledHarness, fallback: string, services: SetupModelServices<R>, retained?: string, useStoredAnswer = true) => Effect.gen(function* () {
  let advertised: ReadonlySet<string> | null = null;

  if (services.query !== null && !ctx.inputChanged(key) && !services.dryRun && program.isFile && (!ctx.nonInteractive || ctx.current(key) !== undefined)) {
    const result = yield* query(services.query, helpArgv(program.executable, program.harness));

    if (result.kind === "ok") advertised = parseAdvertisedEfforts(result.text, program.harness);
  }

  yield* ctx.say("Effort requests: minimal, low, medium, high, xhigh, max. Support may be unknown.");
  yield* ctx.say("The requested effort is stored unchanged. The selected program can adjust or reject an unsupported effort when it runs. Pi can clamp it to a supported level; Claude Code can fall back to a supported effort.");

  const validate = (value: string): string | null => {
    if (!efforts.has(value)) return "Choose minimal, low, medium, high, xhigh or max.";

    if (value === "minimal" && advertised !== null && !advertised.has(value)) return "This program's help does not advertise minimal. Choose another effort.";

    return null;
  };

  if (useStoredAnswer && (ctx.explicitKeys.has(key) || suppliedRecovery(ctx, key))) return yield* validatedNamedText(ctx, key, validate);

  if (services.query === null) {
    yield* ctx.say("Effort metadata is unavailable in this checkout. Supply an effort or keep the existing choice.");

    if (ctx.nonInteractive) return yield* new InitMissingAnswer({ key });
    const effort = yield* askInitText(io, { prompt: "Effort", default: retained, validate });
    ctx.answers[key] = effort;

    return effort;
  }

  if (ctx.nonInteractive) {
    return yield* (ctx.current(key) === undefined ? Effect.fail(new InitMissingAnswer({ key })) : validatedNamedText(ctx, key, validate));
  }

  // A blank answer keeps even an effort some versions do not advertise.
  const selected = yield* askInitText(io, {
    prompt: `Effort (current: ${fallback}; press Enter to keep it)`, validate: (value) => value ? validate(value) : null,
  });

  const effort = selected || fallback;
  ctx.answers[key] = effort;

  return effort;
});

export const planSetupModels = <R>(ctx: InitQuestions, io: InterviewIO, original: string | null, services: SetupModelServices<R>) => Effect.gen(function* () {
  const exists = original !== null;
  const changedStage = stageKeys.some(ctx.inputChanged);
  const changed = changedStage || [...commonKeys, "ai_common", "ai_setup"].some(ctx.inputChanged);

  const keep = () => Effect.gen(function* () {
    yield* ctx.say("Keeping the saved AI settings, including any stage-specific choices.");
    ctx.answers.reviewer = "configured";

    return undefined;
  });

  delete ctx.answers.ai_common_replaced;

  if (exists && !ctx.advanced && ctx.recoveryStep !== "reviewer" && !changed) return yield* keep();
  let common = ctx.current("ai_common") === "yes";
  const explicitCommon = common && ctx.explicitKeys.has("ai_common");

  if (exists && commonKeys.some((key) => ctx.explicitKeys.has(key)) && !common) {
    return yield* inputError("Common AI settings need ai_common=yes before they replace saved stages.");
  }

  let setup = ctx.inputChanged("ai_setup") ? ctx.current("ai_setup") : undefined;

  if (ctx.explicitKeys.has("ai_setup") && setup !== "keep" && setup !== "common" && setup !== "separate") {
    return yield* inputError(`Answer ai_setup is invalid. ${invalidSetup}`);
  }

  if (setup === "keep") return yield* keep();

  if (!changed) {
    if (exists || ctx.advanced) {
      const options = ctx.advanced ? [...(exists ? ["keep"] : []), "common", "separate"] : ["keep", "common"];
      const choices = new Map(options.flatMap((value, index) => [[String(index + 1), value], [value, value]]));
      yield* ctx.say("Use common AI settings for all stages, or keep stage-specific choices.");
      yield* ctx.say(ctx.advanced ? "Separate: edit each stage." : "Separate stage edits need advanced setup.");

      for (const [index, option] of options.entries()) yield* ctx.say(`${index + 1}. ${option}`);
      const answer = yield* ctx.answer("ai_setup", { prompt: "AI setup", default: ctx.advanced ? "separate" : "keep", validate: (value) => choices.has(value) ? null : invalidSetup });
      setup = choices.get(answer);

      if (setup === undefined) return yield* inputError(invalidSetup);
      ctx.answers.ai_setup = setup;

      if (setup === "keep") return yield* keep();
    } else setup = "common";
  }

  const menuCommon = setup === "common";
  const separate = setup === "separate";
  common = common || menuCommon || (!exists && !separate && !changedStage);

  if (common) ctx.answers.ai_common = "yes";
  const existing = exists ? yield* Either.mapLeft(decodeModelSettings(original), () => inputError("Existing model settings are invalid. Fix local_only/models.toml first.")) : null;
  const detected = yield* Effect.suspend(services.detect).pipe(Effect.mapError(() => inputError("Could not detect supported AI programs.")));

  const installed = (["claude-code", "pi"] as const).flatMap((harness) => {
    const entry = detected.find((item) => item.harness === harness);

    return entry?.executable ? [{ ...entry, executable: entry.executable }] : [];
  });

  const first = installed[0];

  if (!first) {
    if (existing) return yield* inputError("The saved AI program is unavailable. Keep the saved settings or explicitly choose another harness.");
    yield* ctx.say("No supported AI harness was found.");
    yield* ctx.say("Install Claude Code or Pi and sign in.");
    yield* ctx.say("Then run: pulse init --step reviewer");
    delete ctx.answers.reviewer;

    return undefined;
  }

  const programAliases = aliases(installed);
  const lookup = (harness: string) => installed.find((entry) => entry.harness === harness);
  let shared: Omit<StageEntry, "batch_size"> | null = null;

  if (common) {
    const harness = yield* chooseProgram(ctx, "ai_program", installed, first.harness);
    const program = lookup(harness);

    if (!program) return yield* inputError(invalidProgram);
    const model = yield* chooseModel(ctx, io, "ai_model", program, undefined, services);
    const effort = yield* chooseEffort(ctx, io, "ai_effort", program, "medium", services);
    shared = { harness, model, effort };
  }

  let content = "";
  let unchanged = exists;

  for (const stage of modelSteps) {
    const previous = existing ? savedStage(existing[stage]) : null;
    const raw: StageValues = previous ? { ...previous } : { harness: first.harness, model: undefined, effort: "medium", batch_size: batchDefaults[stage] };
    const key = (field: typeof fields[number]) => `${stage}_${field}`;
    const touched = separate || common || !previous || fields.some((field) => ctx.inputChanged(key(field)));

    if (touched) {
      const wins = (field: typeof fields[number]) => ctx.explicitKeys.has(key(field)) || (ctx.inputChanged(key(field)) && !(explicitCommon || menuCommon));

      for (const field of fields) {
        // The native path resolves the harness before adopting either choice.
        if (services.query === null && (field === "model" || field === "effort")) continue;

        if (wins(field)) raw[field] = ctx.current(key(field));
        else if (shared && field !== "batch_size") raw[field] = shared[field];
      }

      const requested = Predicate.isString(raw.harness) ? raw.harness : "";
      const program = lookup(programAliases.get(requested) ?? requested);

      if (!program) return yield* inputError(`The saved AI program for ${stage} is unavailable. Keep the saved settings or explicitly choose another harness.`);
      const promptStage = !common && (separate || !previous);
      const harness = wins("harness") || promptStage ? yield* chooseProgram(ctx, key("harness"), installed, program.harness) : program.harness;
      const selected = lookup(harness);

      if (!selected) return yield* inputError(invalidProgram);
      raw.harness = harness;

      if (services.query === null) {
        const commonChoice = shared?.harness === harness ? shared : null;
        const savedChoice = previous?.harness === harness ? previous : null;
        // A stage that declines the common harness must make its own choice.
        const chooseStage = promptStage || (shared !== null && commonChoice === null);
        const model = commonChoice?.model ?? savedChoice?.model;
        raw.model = wins("model") || chooseStage || model === undefined
          ? yield* chooseModel(ctx, io, key("model"), selected, model, services, wins("model")) : model;

        const savedEffort = savedChoice?.model === raw.model ? savedChoice?.effort : undefined;
        const effort = commonChoice?.effort ?? savedEffort;
        raw.effort = wins("effort") || chooseStage || effort === undefined
          ? yield* chooseEffort(ctx, io, key("effort"), selected, "medium", services, savedEffort, wins("effort")) : effort;
      } else {
        if (wins("model") || promptStage) {
          raw.model = yield* chooseModel(ctx, io, key("model"), selected, Predicate.isString(raw.model) ? raw.model : undefined, services);
        }

        if (wins("effort") || promptStage) {
          raw.effort = yield* chooseEffort(ctx, io, key("effort"), selected, Predicate.isString(raw.effort) ? raw.effort : "medium", services);
        }
      }
    }

    const { harness, model, effort, batch_size } = raw;

    if (!Predicate.isString(harness) || !Predicate.isString(model) || !Predicate.isString(effort) || !Predicate.isBigInt(batch_size)) {
      return yield* inputError(`Invalid AI settings for ${stage}.`);
    }

    const row = { harness, model, effort, batch_size };
    const reviewer = yield* Either.mapLeft(decodeStage(stage, row), () => inputError(`Invalid AI settings for ${stage}.`));
    const rendered = line(stage, row);
    unchanged = unchanged && previous !== null && rendered === line(stage, previous);
    content += rendered;

    for (const field of fields) ctx.answers[key(field)] = row[field];
    yield* ctx.say(`The ${stage} step sends profile text and candidate job text through ${names[reviewer.harness]} and its configured model service (recorded provider: ${reviewer.provider}).`);
  }

  yield* ctx.say("Pulse does not verify the route or access. Claude Code settings control its model service.");
  yield* ctx.say("Login and model access are not checked. Listed models are not tested. No model was started.");

  if (exists) {
    yield* ctx.say("Changing these shared AI settings affects all profiles.");

    if (common && !unchanged) ctx.answers.ai_common_replaced = "yes";
  }

  ctx.answers.reviewer = "configured";

  return unchanged ? original : content;
});
