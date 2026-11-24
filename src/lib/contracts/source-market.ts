import { Schema } from "effect";
import { SalaryFacts } from "./salary.ts";

// The six fields of the retained Market source reader. Source owns their SQL.
export const MarketSourceAd = Schema.Struct({
  uuid: Schema.String, first_seen: Schema.String, title: Schema.String,
  employer: Schema.String, locations: Schema.String, topics: Schema.String,
});

export type MarketSourceAd = typeof MarketSourceAd.Type;

export const SourceSalaryRow = Schema.Struct({
  ...SalaryFacts.fields,
  uuid: Schema.String, title: Schema.NullOr(Schema.String), employer: Schema.NullOr(Schema.String),
  detail_changed: Schema.String, closed: Schema.Boolean,
});

export type SourceSalaryRow = typeof SourceSalaryRow.Type;

export const SourceSalaryFacts = Schema.Struct({
  salaries: Schema.Array(SourceSalaryRow),
  text_versions: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export type SourceSalaryFacts = typeof SourceSalaryFacts.Type;
