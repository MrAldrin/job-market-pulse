import { Schema } from "effect";
import type { JsonInput } from "../server/shared/json-input.ts";

export type ReviewSourceObject = Readonly<Record<string, JsonInput>>;

export type OccupationPair = readonly [string, string];

/** Source row and its evidence must come from the same read snapshot. */
export interface SourceListing {
  readonly row: ReviewSourceObject;
  readonly savedDetailChanged: string | null;
  readonly detailEvidence: ReviewSourceObject | null;
  readonly hasLocationPoints: boolean | null;
  readonly locationEvidence: ReviewSourceObject | null;
  readonly versionChanged: string | null;
  readonly geographyEvidenceDigest: string | null;
  readonly occupationPairs: readonly OccupationPair[] | null;
}

export interface SourceListingEvidence {
  readonly hasLocationPoints?: boolean | null;
  readonly locationEvidence?: ReviewSourceObject | null;
  readonly versionChanged?: string | null;
  readonly geographyEvidenceDigest?: string | null;
  readonly occupationPairs?: readonly OccupationPair[] | null;
}

export const SnapshotFields = Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Array(Schema.String), Schema.Null) });

export type SnapshotFields = typeof SnapshotFields.Type;

export const DetailRefresh = Schema.Struct({
  source: Schema.Literal("nav_detail_refresh"), previous_changed: Schema.String,
  detail_changed: Schema.String, refreshed_at: Schema.String,
});

export type DetailRefresh = typeof DetailRefresh.Type;

export const SourceSubReason = Schema.Literal("detail_missing", "detail_identity_mismatch", "detail_inactive", "detail_mismatch", "location_evidence_stale", "admission_metadata_changed", "description_missing", "description_blank", "source_text_too_large");

export const SourceDecision = Schema.Struct({
  would_review: Schema.Boolean, snapshot_id: Schema.NullOr(Schema.String),
  sub_reason: Schema.NullOr(SourceSubReason), provenance: Schema.NullOr(DetailRefresh),
  body: Schema.NullOr(Schema.String), snapshot: Schema.NullOr(SnapshotFields),
});

export type SourceDecision = typeof SourceDecision.Type;

export const AdText = Schema.Struct({
  listing_id: Schema.String, source_version: Schema.String, text: Schema.String,
  fingerprint: Schema.String, byte_count: Schema.Int.pipe(Schema.between(0, 20_000)),
  provenance: Schema.NullOr(DetailRefresh), snapshot: SnapshotFields, snapshot_id: Schema.String,
  detail_changed: Schema.String,
});

export const AdTextFailure = Schema.Struct({
  listing_id: Schema.String,
  reason: Schema.Literal("source_version_changed", "source_fetch_failed", "source_text_too_large", "source_text_unavailable"),
  sub_reason: Schema.NullOr(SourceSubReason),
});

export const AdTextBatch = Schema.Struct({ available: Schema.Array(AdText), unavailable: Schema.Array(AdTextFailure), request_count: Schema.Int });

export type AdTextBatch = typeof AdTextBatch.Type;

/** B4 owns admission and geography; Source only consumes the result. */
export interface GeoAssessment { readonly status: string; readonly reason: string }

export type AdmissionCheck = (content: ReviewSourceObject, listing: SourceListing) => GeoAssessment | null;
