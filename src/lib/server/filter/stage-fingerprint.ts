import { Either } from "effect";
import type { Candidate, ManifestCommon } from "../../contracts/filter.ts";
import { pythonJson, sha256 } from "../shared/python-json.ts";
import { strip } from "../shared/text.ts";
import { FilterInputError } from "./errors.ts";

// Accepted-result reuse is separate from the exact in-flight submission binding
// below. Source versions and admission evidence still guard writes.
export const reviewListingMaterial = ({ id, title, employer, locations, detail_missing }: Candidate) =>
  ({ id, title, employer, locations, detail_missing });

export const reviewMaterialFingerprint = (candidate: ReturnType<typeof reviewListingMaterial>, textFingerprint: string | null): string =>
  sha256(pythonJson({ listing: candidate, ad_text: textFingerprint }));

export const reviewTermsFingerprint = (manifest: ManifestCommon): string =>
  sha256(pythonJson(manifest.fit_preferences.preferred_terms));

export interface StageBinding {
  readonly stage: "title_screen" | "full_review";
  readonly promptVersion: string;
  readonly sourceTextFingerprint?: string;
  readonly snapshotId?: string;
  readonly upstreamResultId?: string;
}

const digest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const invalid = (message: string) => Either.left(new FilterInputError({ message }));

export const stageInputFingerprint = (manifest: ManifestCommon, candidate: Candidate, options: StageBinding): Either.Either<string, FilterInputError> => {
  const { stage, promptVersion, sourceTextFingerprint, snapshotId, upstreamResultId } = options;

  if (stage !== "title_screen" && stage !== "full_review") return invalid("Unknown review stage");

  if (!strip(promptVersion) || Array.from(promptVersion).length > 128 || Array.from(promptVersion).some((character) => (character.codePointAt(0) ?? 0) < 32)) return invalid("Prompt version must be bounded plain text");

  if (stage === "title_screen" && (sourceTextFingerprint !== undefined || snapshotId !== undefined || upstreamResultId !== undefined)) return invalid("Title screening cannot bind full-ad or upstream data");

  if (stage === "full_review" && (upstreamResultId === undefined || !strip(upstreamResultId) || Array.from(upstreamResultId).length > 64)) return invalid("Full review must bind its accepted screening result");

  if (sourceTextFingerprint !== undefined && !digest(sourceTextFingerprint)) return invalid("Ad-text fingerprint must be a SHA-256 digest");

  if (snapshotId !== undefined && (sourceTextFingerprint === undefined || !digest(snapshotId))) return invalid("Ad snapshot ID must bind a text fingerprint");

  if (candidate.geography_evidence_digest !== undefined && !digest(candidate.geography_evidence_digest)) return invalid("Candidate geography evidence digest is invalid");

  if (![manifest.profile_fingerprint, manifest.preferences_fingerprint, manifest.rules_fingerprint].every(digest)) return invalid("Manifest fingerprint is invalid");

  const baseMaterial = {
    id: candidate.id, title: candidate.title, employer: candidate.employer, locations: candidate.locations,
    url: candidate.url, expires_at: candidate.expires_at, detail_missing: candidate.detail_missing,
    geography: candidate.geography, geography_reason: candidate.geography_reason, occupation_categories: candidate.occupation_categories,
  };

  const material = candidate.geography_evidence_digest === undefined ? baseMaterial : { ...baseMaterial, geography_evidence_digest: candidate.geography_evidence_digest };

  const source = sourceTextFingerprint === undefined ? { material, source_version: candidate.version }
    : snapshotId === undefined ? { material, ad_text_fingerprint: sourceTextFingerprint }
      : { material, ad_text_fingerprint: sourceTextFingerprint, snapshot_id: snapshotId };

  return Either.right(sha256(pythonJson({
    stage, stage_schema_version: 1, prompt_version: promptVersion,
    profile_id: manifest.profile_id, profile_fingerprint: manifest.profile_fingerprint,
    preferences_fingerprint: manifest.preferences_fingerprint, rules_fingerprint: manifest.rules_fingerprint,
    scoring_version: manifest.scoring_version, source, upstream_result_id: upstreamResultId ?? null,
  })));
};
