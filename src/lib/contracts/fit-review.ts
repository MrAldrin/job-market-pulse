import { Schema } from "effect";
import { integerToken } from "./support.ts";
import { strip } from "../server/shared/text.ts";

// Measure Python-stripped scalar length, but retain the submitted text.
const reviewText = Schema.String.pipe(Schema.filter((value) => {
  const length = Array.from(strip(value)).length;

  return length >= 1 && length <= 1000;
}));

export const ReviewAssessment = Schema.Struct({
  id: Schema.String,
  // The echoed version is deliberately ignored. Trust the submitted manifest.
  version: Schema.Unknown.pipe(Schema.filter((value) => value !== undefined)),
  fit: Schema.Literal("exceptional", "strong", "possible", "poor", "unknown"),
  reason: reviewText, evidence: Schema.Array(reviewText).pipe(Schema.maxItems(20)),
  uncertainties: Schema.Array(reviewText).pipe(Schema.maxItems(20)),
  hard_constraints: Schema.Literal("pass", "fail", "unknown"), ad_text_reviewed: Schema.Boolean,
});

export const ReviewEnvelope = Schema.Struct({
  schema_version: integerToken.pipe(Schema.filter((value) => value === 1)),
  profile_id: Schema.String, manifest_id: Schema.String, assessed_at: Schema.String,
  complete: Schema.Literal(true), assessments: Schema.Array(ReviewAssessment),
});

export type ReviewEnvelope = typeof ReviewEnvelope.Type;

const titleReason = Schema.String.pipe(Schema.filter((value) => {
  const length = Array.from(strip(value)).length;

  return length >= 1 && length <= 500;
}));

export const TitleScreenAssessment = Schema.Struct({
  id: Schema.String,
  version: Schema.Unknown.pipe(Schema.filter((value) => value !== undefined)),
  outcome: Schema.Literal("advance_to_full_review", "screened_out"),
  reason: titleReason,
});

export const TitleScreenEnvelope = Schema.Struct({
  schema_version: integerToken.pipe(Schema.filter((value) => value === 1)),
  profile_id: Schema.String, manifest_id: Schema.String, assessed_at: Schema.String,
  complete: Schema.Literal(true), assessments: Schema.Array(TitleScreenAssessment),
});

export type TitleScreenEnvelope = typeof TitleScreenEnvelope.Type;
