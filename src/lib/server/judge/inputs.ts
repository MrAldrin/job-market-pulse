import { Either } from "effect";
import type { Candidate, CandidateManifest } from "../../contracts/filter.ts";
import type { ReviewStage, StageInput } from "../../contracts/judge-state.ts";
import { stageInputFingerprint as canonicalStageInputFingerprint, type StageBinding } from "../filter/stage-fingerprint.ts";
import { normalizeIdentity } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { snapshotBindingId } from "./provenance.ts";

// Public Filter contracts own these values. Judge adds no manifest wire codec.
export type CandidateProjection = Candidate;

export type ManifestProjection = CandidateManifest;

export const stageInputFingerprint = (manifest: ManifestProjection, candidate: CandidateProjection, stage: ReviewStage, promptVersion: string, textFingerprint: string | null = null, snapshotId: string | null = null, upstreamResultId: string | null = null) => {
  let binding: StageBinding = { stage, promptVersion };

  if (textFingerprint !== null) binding = { ...binding, sourceTextFingerprint: textFingerprint };

  if (snapshotId !== null) binding = { ...binding, snapshotId };

  if (upstreamResultId !== null) binding = { ...binding, upstreamResultId };

  return Either.mapLeft(canonicalStageInputFingerprint(manifest, candidate, binding), (cause) => new JudgeStateError({ message: cause.message, cause }));
};

export interface StageInputOptions {
  readonly stage: ReviewStage;
  readonly prompt_version: string;
  readonly candidate_ids?: readonly string[];
  readonly source_text_fingerprints?: ReadonlyMap<string, string>;
  readonly upstream_result_ids?: ReadonlyMap<string, string>;
  readonly snapshot_provenance?: ReadonlyMap<string, string>;
}

export const buildStageInputs = (manifest: ManifestProjection, options: StageInputOptions) => Either.gen(function* () {
  const requested = options.candidate_ids === undefined ? null : new Set(options.candidate_ids);

  if (requested !== null && requested.size !== options.candidate_ids?.length) {
    return yield* Either.left(new JudgeStateError({ message: "Requested candidate IDs must be unique" }));
  }

  const result: StageInput[] = [];

  for (const candidate of manifest.candidates) {
    const identity = yield* normalizeIdentity(candidate.id);

    if (requested !== null && !requested.has(identity)) continue;

    const text = options.source_text_fingerprints?.get(identity) ?? null;
    const upstream = options.upstream_result_ids?.get(identity) ?? null;
    const provenance = options.snapshot_provenance?.get(identity) ?? null;
    const snapshotId = yield* snapshotBindingId(provenance, candidate.version);
    const input = yield* stageInputFingerprint(manifest, candidate, options.stage, options.prompt_version, text, snapshotId, upstream);
    result.push({ listing_id: identity, source_version: candidate.version, input_fingerprint: input, source_text_fingerprint: text, upstream_result_id: upstream, snapshot_provenance_json: provenance });
  }

  if (requested !== null && (requested.size !== result.length || result.some((item) => !requested.has(item.listing_id)))) {
    return yield* Either.left(new JudgeStateError({ message: "Requested candidate is not in the manifest" }));
  }

  return result;
});
