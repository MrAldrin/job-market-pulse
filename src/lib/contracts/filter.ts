import { Schema } from "effect";
import { finiteNumber, integerToken } from "./support.ts";

const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const count = integerToken.pipe(Schema.nonNegative());
const textList = Schema.Array(Schema.String);

export const Candidate = Schema.Struct({
  id: Schema.String, version: Schema.String, title: Schema.String, employer: Schema.String,
  locations: textList, url: Schema.String, expires_at: Schema.NullOr(Schema.String),
  detail_missing: Schema.Boolean, geography: Schema.Literal("inside"), geography_reason: Schema.String,
  occupation_categories: textList, geography_evidence_digest: Schema.optional(digest),
});

export type Candidate = typeof Candidate.Type;

export const FitPreferences = Schema.Struct({
  preferred_terms: textList, allowed_occupation_categories: textList,
  preferred_municipalities: textList, nearby_municipalities: textList,
  excluded_title_terms: textList, excluded_employers: textList, excluded_municipalities: textList,
  hard_limits: Schema.Struct({
    geography_radius_km: finiteNumber.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000)),
    geography_radius_is_explicit: Schema.Literal(true), geography_already_applied: Schema.Literal(true),
    exact_origin_included: Schema.Literal(false), other_constraints: Schema.String,
  }),
});

export type FitPreferences = typeof FitPreferences.Type;

export const ManifestCommon = Schema.Struct({
  schema_version: integerToken.pipe(Schema.filter((value) => value === 1)),
  profile_id: Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.maxLength(64)),
  profile_fingerprint: digest, preferences_fingerprint: digest, rules_fingerprint: digest,
  scoring_version: Schema.String, fit_preferences: FitPreferences,
});

export type ManifestCommon = typeof ManifestCommon.Type;

export const CandidateManifest = Schema.Struct({
  ...ManifestCommon.fields,
  coverage_id: digest, candidates: Schema.Array(Candidate), manifest_id: digest,
  checked_at: Schema.String, caught_up: Schema.Literal(true), coverage: Schema.String,
  eligible_count: count, reviewed_count: count, candidate_count: count, remaining_count: count,
  candidate_offset: Schema.NullOr(count), batch_index: count, batch_count: count,
  batch_ids_fingerprint: digest, limit: integerToken.pipe(Schema.between(1, 120)), truncated: Schema.Boolean,
});

export type CandidateManifest = typeof CandidateManifest.Type;
