import { FileSystem } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { parse } from "smol-toml";
import { defaultRejudgeOptions, ModelLabel, modelSteps, ProviderLabel, ReviewerSettingsFile, type ModelStep, type RejudgeOptions, type ReviewerEffort } from "../../contracts/reviewer-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { checkedInstallationSetting } from "../shared/paths.ts";
import { ReviewerError } from "./reviewer-errors.ts";

export const modelSettingsFile = "local_only/models.toml";

export { modelSteps, type ModelStep } from "../../contracts/reviewer-settings.ts";

export const hangTimeoutSeconds = 1800;
export const piMaxStdoutBytes = 1_000_000;
export const piDeadlineSeconds = (_reviewer: Reviewer): number => hangTimeoutSeconds;
const isProviderLabel = Schema.is(ProviderLabel);
const isModelLabel = Schema.is(ModelLabel);

export type Reviewer = Readonly<{
  id: string; harness: "pi" | "claude-code"; provider: string; model: string;
  effort: ReviewerEffort; batch_size: number; max_budget_usd: number | null; timeout_seconds: number;
}>;

export type ModelSettings = Readonly<Record<ModelStep, Reviewer>> & { readonly rejudgeOptions?: RejudgeOptions };

export const rejudgeOptions = (models: ModelSettings) => models.rejudgeOptions ?? defaultRejudgeOptions;

export const rejudgeReviewer = (models: ModelSettings): Reviewer => rejudgeOptions(models).same_as_judge
  ? { ...models.judge, id: "rejudge" } : { ...models.rejudge, batch_size: Math.min(models.rejudge.batch_size, 10) };

const error = (code: string) => new ReviewerError({ code });

export const decodeModelSettings = (text: string): Either.Either<ModelSettings, ReviewerError> => {
  const parsed = Either.try({ try: () => parse(text, { integersAsBigInt: true }), catch: () => error("model_settings_unavailable") });

  return Either.flatMap(parsed, (raw) => {
    const missing = modelSteps.filter((step) => !(step in raw)).sort();

    if (missing.length) return Either.left(error(`model_step_missing:${missing.join(",")}`));
    const decoded = Either.mapLeft(decodeStrict(ReviewerSettingsFile)(raw), () => error("model_settings_invalid"));

    return Either.flatMap(decoded, (settings) => {
      // SAFETY: every modelSteps key is assigned before the record is returned.
      const result = {} as Record<ModelStep, Reviewer>;

      for (const id of modelSteps) {
        const value = settings[id];
        let provider = "anthropic";
        let model = value.model;

        if (value.harness === "pi") {
          const separator = model.indexOf("/");
          provider = separator < 0 ? model : model.slice(0, separator);

          if (!isProviderLabel(provider)) return Either.left(error("model_settings_invalid"));

          if (separator < 0 || separator === model.length - 1) return Either.left(error("model_provider_required"));
          model = model.slice(separator + 1);
        } else if (model.includes("/")) return Either.left(error("model_settings_invalid"));

        if (!isModelLabel(model)) return Either.left(error("model_settings_invalid"));
        result[id] = { id, harness: value.harness, provider, model, effort: value.effort,
          batch_size: value.batch_size, max_budget_usd: null, timeout_seconds: hangTimeoutSeconds };
      }

      const { levels, same_as_judge } = settings.rejudge;

      return Either.right(levels === undefined && same_as_judge === undefined ? result : {
        ...result, rejudgeOptions: { levels: levels ?? [], same_as_judge: same_as_judge ?? true },
      });
    });
  });
};

export class ReviewerSettings extends Context.Tag("pulse/ReviewerSettings")<ReviewerSettings, {
  readonly load: (root: string) => Effect.Effect<ModelSettings, ReviewerError>;
}>() {}

// File access is deferred until load; the tracked example is never a fallback.
export const ReviewerSettingsLive = Layer.effect(ReviewerSettings, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return { load: (root: string) => checkedInstallationSetting(root, modelSettingsFile).pipe(
    Effect.flatMap((path) => fs.readFileString(path)), Effect.provideService(FileSystem.FileSystem, fs),
    Effect.mapError(() => error("model_settings_unavailable")), Effect.flatMap((text) => decodeModelSettings(text)),
  ) };
}));
