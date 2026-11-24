import { Schema } from "effect";
import { boundedInteger, integerToken } from "./support.ts";

const attempt = { attempt_id: Schema.String };

const usage = {
  input_tokens: Schema.optional(Schema.NullOr(boundedInteger(0, 1_000_000))),
  output_tokens: Schema.optional(Schema.NullOr(boundedInteger(0, 1_000_000))),
  wall_time_seconds: Schema.optional(Schema.NullOr(Schema.Union(Schema.Number, integerToken).pipe(Schema.finite(), Schema.nonNegative()))),
  diagnostics: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
};

export const JudgeProtocolInput = Schema.Union(
  Schema.Struct({ type: Schema.Literal("keep_partial"), run_id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("supersede"), run_id: Schema.String, owner_confirmed: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("retry", "skip_retry", "cancel_before_submit"), ...attempt }),
  Schema.Struct({ type: Schema.Literal("submit"), ...attempt,
    harness_label: Schema.optional(Schema.String), provider_label: Schema.optional(Schema.String),
    model_label: Schema.optional(Schema.String), reasoning_level: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("result"), ...attempt, raw_result: Schema.String, ...usage }),
  Schema.Struct({ type: Schema.Literal("failed", "unknown"), ...attempt,
    error_code: Schema.optional(Schema.String), ...usage }),
);

export type JudgeProtocolInput = typeof JudgeProtocolInput.Type;
