import { Schema } from "effect";
import { awareTimestamp, boundedInteger } from "./support.ts";
import { strip } from "../server/shared/text.ts";

// These are the Judge store's private records, not the Filter/fit-review wires.
export const Digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}(?![\s\S])/));
export const Identity = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/));
export const ProfileId = Schema.String.pipe(Schema.maxLength(64), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/));
export const ReviewStage = Schema.Literal("title_screen", "full_review");
export const RunStatus = Schema.Literal("pending", "running", "partial", "completed", "failed", "blocked", "stale", "superseded");
export const AttemptStatus = Schema.Literal("pending", "running", "completed", "failed", "blocked", "unknown");
export const CandidateStatus = Schema.Literal("pending", "screened", "screened_out", "completed");
export const BlockedSubReason = Schema.Literal("detail_missing", "detail_mismatch", "detail_identity_mismatch", "detail_inactive", "description_missing", "description_blank");

export const Label = Schema.String.pipe(Schema.filter((value) =>
  Array.from(value).length <= 128 && strip(value).length > 0 && Array.from(value).every((character) => character.charCodeAt(0) >= 32),
));

export const RunContext = Schema.Struct({
  coverage_id: Digest,
  source_checked_at: awareTimestamp,
  profile_fingerprint: Digest,
  preferences_fingerprint: Digest,
  rules_fingerprint: Digest,
  scoring_version: Schema.NonEmptyString,
  candidate_count: boundedInteger(0, 10_000),
  full_review_batch_size: boundedInteger(1, 10),
});

export const StageInput = Schema.Struct({
  listing_id: Identity,
  source_version: Schema.NonEmptyString,
  input_fingerprint: Digest,
  source_text_fingerprint: Schema.NullOr(Schema.String),
  // Keep raw accepted UUID spelling: it is part of the stage-input fingerprint.
  upstream_result_id: Schema.NullOr(Schema.String),
  snapshot_provenance_json: Schema.NullOr(Schema.String),
});

export const RequestProvenance = Schema.Struct({
  provider_label: Schema.NullOr(Label),
  model_label: Schema.NullOr(Label),
  reasoning_level: Schema.NullOr(Label),
  call_count: boundedInteger(0, 100),
  request_bytes: Schema.NullOr(boundedInteger(0, 2_000_000)),
  response_bytes: Schema.NullOr(boundedInteger(0, 2_000_000)),
  input_tokens: Schema.NullOr(boundedInteger(0, 1_000_000)),
  output_tokens: Schema.NullOr(boundedInteger(0, 1_000_000)),
});

export const RunRecord = Schema.Struct({
  run_id: Identity,
  profile_id: ProfileId,
  status: RunStatus,
  context: RunContext,
  started_at: awareTimestamp,
  completed_at: Schema.NullOr(awareTimestamp),
});

export const RunCandidate = Schema.Struct({
  listing_id: Identity,
  source_version: Schema.String,
  candidate_fingerprint: Digest,
  status: CandidateStatus,
  screening_result_id: Schema.NullOr(Identity),
  full_result_id: Schema.NullOr(Identity),
});

export const StageAttempt = Schema.Struct({
  attempt_id: Identity,
  run_id: Identity,
  profile_id: ProfileId,
  stage: ReviewStage,
  status: AttemptStatus,
  input_fingerprint: Digest,
  manifest_id: Schema.String,
  stage_version: Label,
  prompt_version: Label,
  attempt_number: boundedInteger(1, Number.MAX_SAFE_INTEGER),
  retry_of_attempt_id: Schema.NullOr(Identity),
  requested_at: awareTimestamp,
  completed_at: Schema.NullOr(awareTimestamp),
  candidate_ids: Schema.Array(Identity),
  error_code: Schema.NullOr(Schema.String),
  provenance: RequestProvenance,
  blocked_sub_reason: Schema.NullOr(Schema.String),
});

export type ReviewStage = typeof ReviewStage.Type;

export type RunStatus = typeof RunStatus.Type;

export type AttemptStatus = typeof AttemptStatus.Type;

export type RunContext = typeof RunContext.Type;

export type StageInput = typeof StageInput.Type;

export type RequestProvenance = typeof RequestProvenance.Type;

export type RunRecord = typeof RunRecord.Type;

export type RunCandidate = typeof RunCandidate.Type;

export type StageAttempt = typeof StageAttempt.Type;

export const emptyProvenance: RequestProvenance = {
  provider_label: null, model_label: null, reasoning_level: null, call_count: 1,
  request_bytes: null, response_bytes: null, input_tokens: null, output_tokens: null,
};

export const CompletedReviewResult = Schema.Struct({
  status: Schema.Literal("recorded", "already_recorded"), recorded_count: boundedInteger(1, 120),
  eligible_count: Schema.NonNegativeInt, reviewed_count: Schema.NonNegativeInt,
  remaining_count: Schema.NonNegativeInt, batch_count: Schema.NonNegativeInt,
  coverage_id: Digest, manifest_id: Digest,
});

export type CompletedReviewResult = typeof CompletedReviewResult.Type;
