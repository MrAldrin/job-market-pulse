import { Either, Predicate, Schema } from "effect";
import { AdText, AdTextBatch } from "../../contracts/source-review.ts";
import { snapshotDigest } from "../source/review-text.ts";
import { pythonJson, sha256 } from "../shared/python-json.ts";
import { WorkflowError } from "./workflow-errors.ts";
import { MAX_MODEL_CALLS_PER_RUN } from "./core.ts";

export { MAX_MODEL_CALLS_PER_RUN };

export const MAX_CANDIDATES_PER_RUN = 120;
export const MAX_OUTPUT_TOKENS_PER_CALL = 50_000;
export const MIN_OUTPUT_TOKENS_PER_CALL = 16;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export { PROFILE_TEXT_MAX_BYTES } from "../../contracts/profile.ts";

const failure = (code: string) => Either.left(new WorkflowError({ code }));
const positive = (value: number, maximum: number, code: string) => Number.isInteger(value) && value >= 1 && value <= maximum ? Either.right(value) : failure(code);

export const validateRunLimits = (candidates: number, calls: number) => Either.gen(function* () {
  return {
    maxCandidates: yield* positive(candidates, MAX_CANDIDATES_PER_RUN, "invalid_candidate_limit"),
    maxCalls: yield* positive(calls, MAX_MODEL_CALLS_PER_RUN, "invalid_call_limit"),
  };
});

export const validateOutputTokenCap = (value: number) => Number.isInteger(value) && value >= MIN_OUTPUT_TOKENS_PER_CALL && value <= MAX_OUTPUT_TOKENS_PER_CALL
  ? Either.right(value) : failure("invalid_output_token_cap");

// UUID accepts all canonical 128-bit identities, not only one UUID generation version.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normalizeListingIds = (ids: readonly string[] | null, maxCandidates: number): Either.Either<readonly string[] | null, WorkflowError> => {
  if (ids === null) return Either.right(null);

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Predicate.isString(id) && uuid.test(id))) return failure("invalid_listing_ids");

  if (ids.length > maxCandidates) return failure("listing_ids_exceed_candidate_limit");
  const canonical = ids.map((id) => id.toLowerCase());

  return new Set(canonical).size === canonical.length ? Either.right(canonical.sort()) : failure("invalid_listing_ids");
};

const strictAd = Schema.decodeUnknownEither(Schema.typeSchema(AdText), { onExcessProperty: "error" });
const snapshotKeys = new Set(["title", "employer", "locations", "expires_at", "occupation_categories", "geography", "geography_reason"]);
const stringList = (value: string | readonly string[] | null | undefined): value is readonly string[] => Array.isArray(value) && value.every(Predicate.isString);

/** Recheck returned bytes and the Source-owned snapshot digest before a model sees them. */
export const checkTextBinding = (ad: typeof AdText.Type, expectedVersion: string): Either.Either<void, WorkflowError> => {
  if (Either.isLeft(strictAd(ad)) || !ad.text.isWellFormed()) return failure("source_text_binding_invalid");

  const snapshot = ad.snapshot;
  const hasGeo = Object.hasOwn(snapshot, "geography");

  const valid = ad.source_version === expectedVersion && new TextEncoder().encode(ad.text).length === ad.byte_count
    && sha256(ad.text) === ad.fingerprint && Object.keys(snapshot).every((key) => snapshotKeys.has(key))
    && Predicate.isString(snapshot.title) && Predicate.isString(snapshot.employer) && stringList(snapshot.locations)
    && Object.hasOwn(snapshot, "expires_at") && (snapshot.expires_at === null || Predicate.isString(snapshot.expires_at))
    && (!Object.hasOwn(snapshot, "occupation_categories") || stringList(snapshot.occupation_categories))
    && hasGeo === Object.hasOwn(snapshot, "geography_reason")
    && (!hasGeo || (snapshot.geography === "inside" && Predicate.isString(snapshot.geography_reason)));

  if (!valid) return failure("source_text_binding_invalid");
  const digest = snapshotDigest(snapshot, ad.text);

  return Either.isRight(digest) && digest.right === ad.snapshot_id ? Either.right(undefined) : failure("source_text_binding_invalid");
};

/** The envelope binds reviewed expiry and detail refresh, but never stores the ad body. */
export const snapshotProvenance = (ads: ReadonlyMap<string, typeof AdText.Type> | null): Either.Either<Readonly<Record<string, string>> | null, WorkflowError> => Either.gen(function* () {
  if (ads === null) return null;
  const entries: [string, string][] = [];

  for (const [id, ad] of ads) {
    yield* checkTextBinding(ad, ad.source_version);
    const expiry = ad.snapshot.expires_at;

    if (expiry !== null && !Predicate.isString(expiry)) return yield* failure("source_text_binding_invalid");
    entries.push([id, pythonJson({ format_version: 1, snapshot_id: ad.snapshot_id, expires_at: expiry, provenance: ad.provenance })]);
  }

  return Object.fromEntries(entries);
});

export const checkTextBatch = (batch: AdTextBatch, missingIds: readonly string[]): Either.Either<void, WorkflowError> => {
  if (!Number.isInteger(batch.request_count) || batch.request_count < 0 || batch.request_count > missingIds.length + 1) return failure("source_text_request_budget_invalid");

  if (Either.isLeft(Schema.decodeUnknownEither(Schema.typeSchema(AdTextBatch), { onExcessProperty: "error" })(batch))) return failure("source_text_batch_invalid");

  const available = batch.available.map((ad) => ad.listing_id);
  const unavailable = batch.unavailable.map((ad) => ad.listing_id);
  const all = [...available, ...unavailable];
  const wanted = new Set(missingIds);

  return new Set(all).size === all.length && all.length === wanted.size && all.every((id) => wanted.has(id))
    ? Either.right(undefined) : failure("source_text_batch_invalid");
};
