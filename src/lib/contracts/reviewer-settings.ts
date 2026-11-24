import { Schema } from "effect";
import { boundedInteger } from "./support.ts";

export const modelSteps = ["screen", "judge", "rejudge", "calibrate"] as const;
export const ModelStep = Schema.Literal(...modelSteps);

export type ModelStep = typeof ModelStep.Type;

export const claudeModelAliases = ["opus", "sonnet", "haiku"] as const;

export const ReviewerHarnessId = Schema.Literal("pi", "claude-code");
export const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}(?![\s\S])/;
export const ModelLabel = Schema.String.pipe(Schema.pattern(labelPattern));
export const ProviderLabel = ModelLabel.pipe(Schema.filter((value) => !value.includes("/")));

export const reviewerEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ReviewerEffort = Schema.Literal(...reviewerEfforts);

export type ReviewerEffort = typeof ReviewerEffort.Type;

const entry = (max: number) => Schema.Struct({
  harness: ReviewerHarnessId, model: Schema.String,
  effort: ReviewerEffort,
  batch_size: boundedInteger(1, max),
});

export const fitLevels = ["exceptional", "strong", "possible", "poor", "unknown"] as const;

export const FitLevel = Schema.Literal(...fitLevels);

export const RejudgeOptions = Schema.Struct({
  levels: Schema.Array(FitLevel).pipe(Schema.maxItems(fitLevels.length), Schema.filter((levels) => new Set(levels).size === levels.length)),
  same_as_judge: Schema.Boolean,
});

export type RejudgeOptions = typeof RejudgeOptions.Type;

export const defaultRejudgeOptions: RejudgeOptions = { levels: [], same_as_judge: true };

export const ReviewerSettingsFile = Schema.Struct({
  screen: entry(120), judge: entry(10), calibrate: entry(120),
  rejudge: Schema.Struct({ ...entry(120).fields, levels: Schema.optional(RejudgeOptions.fields.levels), same_as_judge: Schema.optional(Schema.Boolean) }),
});
