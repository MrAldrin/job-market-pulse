import { Either } from "effect";
import type { Candidate, CandidateManifest } from "../../src/lib/contracts/filter.ts";
import type { RunContext } from "../../src/lib/contracts/judge-state.ts";
import { buildManifest, manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { filterSettings } from "../filter/fixtures.ts";

export const judgeCandidate = (id: string, version: string, fields: Partial<Candidate> = {}): Candidate => ({
  id, version, title: "Invented analyst", employer: "Synthetic", locations: ["Oslo"],
  url: "https://example.invalid/job", expires_at: null, detail_missing: false,
  geography: "inside", geography_reason: "Owned synthetic geography evidence", occupation_categories: ["IT"],
  ...fields,
});

// Synthetic values, real public constructors. No private manifest wire or validator.
export const judgeManifest = (candidates: readonly Candidate[], checkedAt: string, profileId = "invented"): CandidateManifest =>
  Either.getOrThrow(buildManifest(Either.getOrThrow(manifestCommon(profileId, filterSettings())), candidates, checkedAt));

export const judgeRunContext = (manifest: CandidateManifest): RunContext => ({
  coverage_id: manifest.coverage_id, source_checked_at: manifest.checked_at,
  profile_fingerprint: manifest.profile_fingerprint, preferences_fingerprint: manifest.preferences_fingerprint,
  rules_fingerprint: manifest.rules_fingerprint, scoring_version: manifest.scoring_version,
  candidate_count: manifest.candidates.length, full_review_batch_size: 5,
});
