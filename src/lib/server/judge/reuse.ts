import { Effect } from "effect";
import type { CandidateManifest } from "../../contracts/filter.ts";
import type { StageInput } from "../../contracts/judge-state.ts";
import { reviewTemplate } from "../filter/review.ts";
import type { PythonJson } from "../shared/python-json.ts";
import { claimAttempt } from "./attempts.ts";
import { recordGeneratedReusedFullBatch } from "./batches.ts";
import { isoInstant } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { decodeStored, write, type JudgeSession } from "./session.ts";
import { StoredJsonObject, type StoredStageResult } from "./stored.ts";

export interface ReusedFullReviewOptions {
  readonly manifest: CandidateManifest;
  readonly inputs: readonly StageInput[];
  readonly matched: ReadonlyMap<string, StoredStageResult>;
  readonly stage_version: string;
  readonly prompt_version: string;
  readonly now: bigint;
  readonly review_source_material?: ReadonlyMap<string, string>;
  readonly max_age_micros: bigint;
}

export const recordReusedFullReviews = (session: JudgeSession, runId: string, options: ReusedFullReviewOptions) => Effect.gen(function* () {
  const assessments: PythonJson[] = [];

  for (const input of options.inputs) {
    const earlier = options.matched.get(input.listing_id);

    if (earlier === undefined) return yield* new JudgeStateError({ message: "Matched full review is missing" });

    const { assessed_at: _earlierTime, ...assessment } = yield* decodeStored(StoredJsonObject, earlier.value);
    assessments.push({ ...assessment, version: input.source_version });
  }

  const raw: PythonJson = { ...reviewTemplate(options.manifest), complete: true, assessed_at: yield* isoInstant(options.now), assessments };

  return yield* write(session, Effect.gen(function* () {
    const claim = yield* claimAttempt(session, runId, {
      stage: "full_review", manifest: options.manifest, inputs: options.inputs,
      stage_version: options.stage_version, prompt_version: options.prompt_version, now: options.now,
    });

    if (claim.attempt.status !== "pending") return [];

    return yield* recordGeneratedReusedFullBatch(session, claim.attempt.attempt_id, {
      submitted_manifest: options.manifest, current_manifest: options.manifest,
      raw, now: options.now, max_age_micros: options.max_age_micros, review_source_material: options.review_source_material,
    }, options.matched);
  }));
});
