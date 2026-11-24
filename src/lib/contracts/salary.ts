import { Schema } from "effect";

export const SalaryFacts = Schema.Struct({
  form: Schema.NullOr(Schema.Literal("range", "single", "vague", "max")),
  min_nok: Schema.NullOr(Schema.Number),
  max_nok: Schema.NullOr(Schema.Number),
  period: Schema.NullOr(Schema.Literal("year", "month", "hour")),
  sko_code: Schema.NullOr(Schema.String),
  ltr_min: Schema.NullOr(Schema.Int),
  ltr_max: Schema.NullOr(Schema.Int),
  period_inferred: Schema.Boolean,
  amount_unclear: Schema.Boolean,
});

export type SalaryFacts = typeof SalaryFacts.Type;
