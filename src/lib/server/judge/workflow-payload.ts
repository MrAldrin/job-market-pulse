import { Either, Predicate, Schema } from "effect";
import { CandidateManifest } from "../../contracts/filter.ts";
import type { ReviewStage } from "../../contracts/judge-state.ts";
import type { AdText } from "../../contracts/source-review.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { reviewTemplate } from "../filter/review.ts";
import { sha256 } from "../shared/python-json.ts";
import { reviewListingMaterial } from "../filter/stage-fingerprint.ts";
import { PROMPT_INSTRUCTIONS, REJUDGE_INSTRUCTIONS } from "./prompts.ts";
import { WorkflowError } from "./workflow-errors.ts";
import { checkTextBinding, MAX_REQUEST_BYTES, PROFILE_TEXT_MAX_BYTES } from "./workflow-support.ts";

export interface ReviewPayload {
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly request_bytes: number;
}

export const promptListing = (candidate: CandidateManifest["candidates"][number], ad?: typeof AdText.Type) => {
  const listing = reviewListingMaterial(candidate);
  const detail = ad?.snapshot;

  return detail === undefined ? listing : { ...listing, title: Predicate.isString(detail.title) ? detail.title : listing.title,
    employer: Predicate.isString(detail.employer) ? detail.employer : listing.employer, locations: Array.isArray(detail.locations) ? detail.locations : listing.locations };
};

export const buildPayload = (stage: ReviewStage, manifest: CandidateManifest, profileText: string, ads: ReadonlyMap<string, typeof AdText.Type> | null, rejudge = false): Either.Either<ReviewPayload, WorkflowError> => Either.gen(function* () {
  yield* Either.mapLeft(decodeStrict(Schema.typeSchema(CandidateManifest))(manifest), () => new WorkflowError({ code: "source_manifest_invalid" }));

  if (!profileText.isWellFormed() || new TextEncoder().encode(profileText).length > PROFILE_TEXT_MAX_BYTES || sha256(profileText) !== manifest.profile_fingerprint) return yield* Either.left(new WorkflowError({ code: "profile_binding_changed" }));
  const candidates = [];

  for (const candidate of manifest.candidates) {
    const ad = ads?.get(candidate.id);

    if (ad !== undefined) yield* checkTextBinding(ad, candidate.version);

    if (stage === "full_review" && ad === undefined) return yield* Either.left(new WorkflowError({ code: "full_review_text_missing" }));

    const safe = { ...promptListing(candidate, ad), version: candidate.version };

    candidates.push(stage === "full_review" ? { ...safe, untrusted_ad_text: ad?.text } : safe);
  }

  const template = stage === "full_review" ? reviewTemplate(manifest) : {
    schema_version: 1, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id,
    assessed_at: "<coordinator supplies assessment time>", complete: true,
    assessments: manifest.candidates.map((candidate) => ({ id: candidate.id, version: candidate.version, outcome: "advance_to_full_review", reason: "<short title-based reason>" })),
  };

  const systemPrompt = rejudge ? REJUDGE_INSTRUCTIONS : PROMPT_INSTRUCTIONS[stage];

  const userPrompt = JSON.stringify({ profile: profileText, preferences: { preferred_terms: manifest.fit_preferences.preferred_terms },
    candidates, response_template: template });

  const requestBytes = new TextEncoder().encode(JSON.stringify({ system_prompt: systemPrompt, user_prompt: userPrompt })).length;

  if (requestBytes > MAX_REQUEST_BYTES) return yield* Either.left(new WorkflowError({ code: "model_request_too_large" }));

  return { system_prompt: systemPrompt, user_prompt: userPrompt, request_bytes: requestBytes };
});
