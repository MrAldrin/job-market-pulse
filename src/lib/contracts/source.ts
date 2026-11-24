import { Schema } from "effect";
import type { ManifestSourceSnapshot, SourceAd } from "./source-readers.ts";

export const CollectionResult = Schema.Struct({ pages: Schema.Int, events: Schema.Int, caught_up: Schema.Boolean });

export type CollectionResult = typeof CollectionResult.Type;

export const LocationEvidenceRefresh = Schema.Struct({ candidates: Schema.Int, current_evidence: Schema.Int, eligible: Schema.Int, attempted: Schema.Int, recorded: Schema.Int, pending: Schema.Int });

export type LocationEvidenceRefresh = typeof LocationEvidenceRefresh.Type;

export const OccupationRefresh = Schema.Struct({ inside: Schema.Int, pending_before: Schema.Int, attempted: Schema.Int, stored: Schema.Int, closed: Schema.Int, pending: Schema.Int });

export type OccupationRefresh = typeof OccupationRefresh.Type;

export const SourceRefreshSummary = Schema.Struct({
  ready: Schema.Boolean, checked_at: Schema.NullOr(Schema.String), feed_requests: Schema.Int,
  location_requests: Schema.Int, location_attempted: Schema.Int, location_resolved: Schema.Int,
  location_unknown: Schema.Int, occupation_requests: Schema.Int, occupation_pending: Schema.Int,
});

export type SourceRefreshSummary = typeof SourceRefreshSummary.Type;

export const RankedMissingAd = Schema.Struct({ uuid: Schema.String, interest_score: Schema.Number.pipe(Schema.finite()) });
export const LocationCandidate = Schema.Struct({ uuid: Schema.String });
export const InsideJob = Schema.Struct({ uuid: Schema.String, source_changed_at: Schema.String });

export type SourceFilterSnapshot = Pick<ManifestSourceSnapshot, "ads" | "location_points" | "occupation_pairs">;

// B4 supplies these decisions. Source only validates identities and applies bounds.
export interface FilterSourcePolicy {
  readonly rankMissing: (ads: readonly SourceAd[]) => readonly (typeof RankedMissingAd.Type)[];
  readonly locationCandidates: (snapshot: SourceFilterSnapshot) => readonly (typeof LocationCandidate.Type)[];
  readonly insideJobs: (snapshot: SourceFilterSnapshot) => readonly (typeof InsideJob.Type)[];
}

export const CollectionOptions = Schema.Struct({
  maxPages: Schema.optional(Schema.Int.pipe(Schema.between(0, 20))), since: Schema.optional(Schema.String),
  graceDays: Schema.optional(Schema.Int.pipe(Schema.between(0, 14))), now: Schema.optional(Schema.String),
});

export type CollectionOptions = typeof CollectionOptions.Type;
