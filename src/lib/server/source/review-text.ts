import { Clock, Effect, Either, Option, Predicate, Schema } from "effect";
import { AdTextBatch, SourceDecision, type AdmissionCheck, type DetailRefresh, type GeoAssessment, type OccupationPair, type SnapshotFields, type SourceListing, type SourceListingEvidence } from "../../contracts/source-review.ts";
import type { JsonInput } from "../shared/json-input.ts";
import { codepointOrder, pythonJson, sha256 } from "../shared/python-json.ts";
import { caseFold, collapseWhitespace, strip } from "../shared/text.ts";
import { verifyWorkplaceEvidence, type WorkplaceEvidenceInput } from "../shared/workplace-fingerprint.ts";
import { asObject, instant, locationLabels, MAX_FULL_TEXT_BYTES, rawObject, sourceJson, text, timestamp, truthy, utcText, uuid, type SourceObject } from "./core.ts";
import { SourceError } from "./errors.ts";
import { NavClient, type NavSession } from "./nav-client.ts";
import type { SourceSql, StoreError } from "./store.ts";

export const sourceListing = (row: SourceObject, detailEvidence: SourceObject | null, evidence: SourceListingEvidence = {}): SourceListing => ({
  row, savedDetailChanged: Predicate.isString(detailEvidence?.detail_changed) ? detailEvidence.detail_changed : null,
  detailEvidence, hasLocationPoints: evidence.hasLocationPoints ?? null, locationEvidence: evidence.locationEvidence ?? null,
  versionChanged: evidence.versionChanged ?? null, geographyEvidenceDigest: evidence.geographyEvidenceDigest ?? null,
  occupationPairs: evidence.occupationPairs ?? null,
});

export const snapshotDigest = (fields: SnapshotFields, body: string): Either.Either<string, "invalid_unicode"> => {
  const payload: SnapshotFields = { ...fields, description: body };

  const valid = Object.entries(payload).every(([key, value]) => key.isWellFormed()
    && (value === null || (Predicate.isString(value) ? value.isWellFormed() : value.every((item) => item.isWellFormed()))));

  return valid ? Either.right(sha256(pythonJson(payload, false))) : Either.left("invalid_unicode");
};

type MutableSnapshotFields = { -readonly [key in keyof SnapshotFields]: SnapshotFields[key] };

const decision = Schema.decodeUnknownSync(SourceDecision);

const blocked = (sub_reason: NonNullable<SourceDecision["sub_reason"]>): SourceDecision => decision({
  would_review: false, snapshot_id: null, sub_reason, provenance: null, body: null, snapshot: null,
});

const clock = (value: JsonInput | undefined): string | null => Either.getOrNull(timestamp(value));
const micros = (value: string): bigint => Option.getOrThrow(instant(value));
const json = (value: JsonInput | undefined): JsonInput | undefined => Predicate.isString(value) ? Either.getOrUndefined(sourceJson(value)) : undefined;
const strings = (value: JsonInput | undefined): readonly string[] | null => Array.isArray(value) && value.every(Predicate.isString) ? value : null;
const same = (a: JsonInput | undefined, b: JsonInput | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

const occupationPairs = (content: SourceObject): readonly OccupationPair[] | null => {
  const categories = content.occupationCategories ?? [];

  if (!Array.isArray(categories)) return null;

  const pairs = new Map<string, OccupationPair>();

  for (const value of categories) {
    const item = asObject(value);

    if (!item || [item.level1, item.level2].some((level) => level !== undefined && level !== null && !Predicate.isString(level))) return null;

    const pair: OccupationPair = [collapseWhitespace(text(item.level1)), collapseWhitespace(text(item.level2))];

    if (pair[0]) pairs.set(JSON.stringify(pair), pair);
  }

  return [...pairs.values()].sort((a, b) => codepointOrder(a[0], b[0]) || codepointOrder(a[1], b[1]));
};

const snapshotFields = (content: SourceObject): SnapshotFields | null => {
  const employer = asObject(content.employer);
  const locations = content.workLocations;
  const expiry = truthy(content.expires) ? clock(content.expires) : null;

  if (!Predicate.isString(content.title) || !Predicate.isString(employer?.name)
    || !Array.isArray(locations) || !locations.every((item) => asObject(item) !== undefined)
    || (truthy(content.expires) && expiry === null)) return null;

  return { title: content.title, employer: employer.name, locations: locationLabels(locations), expires_at: expiry };
};

const acceptText = (detail: SourceObject, provenance: DetailRefresh | null, includeOccupations = false, geography: GeoAssessment | null = null): Either.Either<SourceDecision, SourceError> => Either.gen(function* () {
  const content = asObject(detail.ad_content);

  if (!content || !Predicate.isString(content.description)) return blocked("description_missing");

  const body = strip(content.description);

  if (!body) return blocked("description_blank");

  if (!body.isWellFormed()) return blocked("detail_mismatch");

  if (new TextEncoder().encode(body).length > MAX_FULL_TEXT_BYTES) return blocked("source_text_too_large");

  const fields = snapshotFields(content);

  if (!fields) return blocked("detail_mismatch");

  const snapshot: MutableSnapshotFields = { ...fields };

  if (includeOccupations || Object.hasOwn(content, "occupationCategories")) {
    const pairs = occupationPairs(content);

    if (pairs === null) return blocked("detail_mismatch");

    snapshot.occupation_categories = [...new Set(pairs.map(([a, b]) => b ? `${a} / ${b}` : a))].sort((a, b) => codepointOrder(caseFold(a), caseFold(b)));
  }

  if (geography) { snapshot.geography = geography.status; snapshot.geography_reason = geography.reason; }

  const digest = snapshotDigest(snapshot, body);

  if (Either.isLeft(digest)) return yield* Either.left(failure("source_text_fetch_failed"));

  return decision({
    would_review: true, snapshot_id: digest.right, sub_reason: null, provenance, body, snapshot,
  });
});

/** Compare one ephemeral detail with evidence from one frozen source snapshot. */
export const checkSourceVersion = (listing: SourceListing, rawDetail: JsonInput, options: { readonly now: Date; readonly admissionCheck?: AdmissionCheck | null }): Either.Either<SourceDecision, SourceError> => Either.gen(function* () {
  const detail = asObject(rawDetail);
  const row = listing.row;

  if (!detail || detail.status === "DELETED") return blocked("detail_missing");

  if (detail.uuid !== row.uuid) return blocked("detail_identity_mismatch");

  if (detail.status !== "ACTIVE") return blocked("detail_inactive");

  if (listing.detailEvidence && listing.detailEvidence.detail_changed !== undefined && listing.detailEvidence.detail_changed !== null && !Predicate.isString(listing.detailEvidence.detail_changed)) return blocked("detail_mismatch");

  const changed = clock(detail.sistEndret);
  const legacy = listing.savedDetailChanged === null;
  const saved = clock(legacy ? row.changed : listing.savedDetailChanged);

  if (!changed || !saved) return blocked("detail_mismatch");

  const content = asObject(detail.ad_content);

  if (micros(changed) <= micros(saved)) {
    const lag = micros(saved) - micros(changed);
    const fields = content ? snapshotFields(content) : null;
    let labels = strings(json(row.locations));
    const employer = content ? asObject(content.employer) : undefined;

    const matchedBeforeLocations = ((!legacy && lag === 0n) || (legacy && lag <= 300_000_000n))
      && content?.uuid === row.uuid && clock(content?.updated) !== null && Array.isArray(content?.workLocations)
      && content.workLocations.length <= 100 && content.workLocations.every((item) => asObject(item) !== undefined)
      && employer !== undefined && content.title === row.title && employer.name === row.employer;

    if (matchedBeforeLocations) {
      const raw = Predicate.isString(row.locations) ? yield* sourceJson(row.locations).pipe(Either.mapLeft(() => failure("source_text_fetch_failed"))) : yield* Either.left(failure("source_text_fetch_failed"));

      if (raw === null || (!Array.isArray(raw) && !Predicate.isString(raw) && !Predicate.isRecord(raw))) return yield* Either.left(failure("source_text_fetch_failed"));

      if (Predicate.isString(raw)) labels = Array.from(raw);
      else if (!Array.isArray(raw) && Predicate.isRecord(raw)) labels = Object.keys(raw);
      else if (Array.isArray(raw) && raw.length > 1 && raw.some(Predicate.isString) && !raw.every(Predicate.isString)) return yield* Either.left(failure("source_text_fetch_failed"));
    }

    const savedExpiry = truthy(row.expires) ? clock(row.expires) : null;

    if ((!legacy && lag !== 0n) || (legacy && lag > 300_000_000n)
      || !content || content.uuid !== row.uuid || clock(content.updated) === null
      || !Array.isArray(content.workLocations) || content.workLocations.length > 100
      || !fields || !labels || fields.title !== row.title || fields.employer !== row.employer
      || !same(fields.locations, [...labels].sort(codepointOrder))
      || (truthy(row.expires) && savedExpiry === null) || fields.expires_at !== savedExpiry
      || (savedExpiry !== null && micros(savedExpiry) <= BigInt(options.now.getTime()) * 1000n)) return blocked("detail_mismatch");

    return yield* acceptText(detail, null);
  }

  if (!content || content.uuid !== row.uuid || clock(content.updated) === null || !Object.hasOwn(content, "expires")) return blocked("detail_mismatch");

  const expiry = content.expires === null ? null : clock(content.expires);
  const fields = snapshotFields(content);

  if ((content.expires !== null && expiry === null) || !fields || !Array.isArray(content.workLocations) || content.workLocations.length > 100) return blocked("detail_mismatch");

  if (expiry !== null && micros(expiry) <= BigInt(options.now.getTime()) * 1000n) return blocked("detail_inactive");

  if (listing.hasLocationPoints !== false) {
    const evidence = listing.locationEvidence;

    if (!evidence || !Predicate.isString(listing.geographyEvidenceDigest) || !Predicate.isString(evidence.provenance)
      || !Predicate.isString(evidence.points) || !Predicate.isString(row.uuid) || !Predicate.isString(row.changed)
      || (evidence.incomplete !== false && evidence.incomplete !== 0 && evidence.incomplete !== 0n)) return blocked("location_evidence_stale");

    const input: WorkplaceEvidenceInput = {
      provenance: evidence.provenance, uuid: row.uuid, sourceVersion: row.changed, versionChanged: listing.versionChanged,
      incomplete: false, pointsJson: evidence.points, currentDetailContent: content,
    };

    const verified = verifyWorkplaceEvidence(listing.detailEvidence ? { ...input, currentDetailEvidence: listing.detailEvidence } : input);

    if (Option.isNone(verified) || verified.value.geography_digest !== listing.geographyEvidenceDigest) return blocked("location_evidence_stale");
  }

  let admission: GeoAssessment | null = null;
  const savedExpiry = row.expires === null ? null : clock(row.expires);

  if (row.expires !== null && savedExpiry === null) return blocked("admission_metadata_changed");

  const admissionCheck = options.admissionCheck;

  if (admissionCheck) {
    const admitted = Either.try({
      try: () => admissionCheck({ ...content, _source_detail_changed: changed }, listing),
      catch: (cause) => cause instanceof TypeError || cause instanceof RangeError || cause instanceof SyntaxError ? "validation" as const : "unexpected" as const,
    });

    if (Either.isLeft(admitted)) {
      if (admitted.left === "validation") return blocked("admission_metadata_changed");

      return yield* Either.left(failure("source_text_fetch_failed"));
    }

    admission = admitted.right;

    if (admission === null || admission.status !== "inside") return blocked("admission_metadata_changed");
  } else {
    const currentPairs = occupationPairs(content);
    const savedPairs = listing.occupationPairs;
    const labels = strings(json(row.locations));

    if (currentPairs === null || savedPairs === null || !same(currentPairs, [...new Map(savedPairs.map((pair) => [JSON.stringify(pair), pair])).values()].sort((a, b) => codepointOrder(a[0], b[0]) || codepointOrder(a[1], b[1])))
      || !labels || fields.title !== row.title || fields.employer !== row.employer || !same(fields.locations, [...labels].sort(codepointOrder))) return blocked("admission_metadata_changed");
  }

  if (savedExpiry !== null && (expiry === null || micros(expiry) > micros(savedExpiry))) return blocked("admission_metadata_changed");

  const previous = clock(row.changed);

  if (!previous || micros(changed) <= micros(previous)) return blocked("detail_mismatch");

  return yield* acceptText(detail, { source: "nav_detail_refresh", previous_changed: previous, detail_changed: changed,
    refreshed_at: utcText(BigInt(options.now.getTime()) * 1000n, "seconds") }, true, admission);
});

export interface CurrentReviewEvidence {
  readonly ad: SourceObject | null;
  readonly versionExists: boolean;
  readonly versionChanged: string | null;
  readonly detailEvidence: SourceObject | null;
  readonly hasLocationPoints: boolean;
  readonly locationEvidence: SourceObject | null;
  readonly occupationPairs: readonly OccupationPair[];
}

/** Reader methods share the caller-owned readonly transaction. */
export interface ReviewSourceReader {
  readonly hasDetailVersions: (sql: SourceSql) => Effect.Effect<boolean, StoreError>;
  readonly readCurrentAd: (sql: SourceSql, id: string, includeDetailVersions: boolean) => Effect.Effect<CurrentReviewEvidence, StoreError>;
}

export const reviewSourceReader: ReviewSourceReader = {
  hasDetailVersions: (sql) => Effect.promise(() => import("./readers.ts")).pipe(Effect.flatMap((reader) => reader.hasDetailVersions(sql))),
  readCurrentAd: (sql, id, includeDetailVersions) => Effect.gen(function* () {
    const reader = yield* Effect.promise(() => import("./readers.ts"));
    const evidence = yield* reader.readCurrentAd(sql, id, includeDetailVersions);
    const ad = evidence.ad === null ? null : yield* Schema.decodeUnknownEither(rawObject)(evidence.ad).pipe(Either.mapLeft(() => failure("source_text_fetch_failed")));

    return { ad, versionExists: evidence.version_exists, versionChanged: evidence.version_changed,
      detailEvidence: evidence.detail_evidence, hasLocationPoints: evidence.has_location_points,
      locationEvidence: evidence.location_evidence, occupationPairs: evidence.occupation_pairs };
  }),
};

const failure = (code: string) => new SourceError({ message: code, code });

export interface FetchCurrentAdTextsOptions {
  readonly databasePath: string;
  readonly manifest: SourceObject;
  readonly candidates: readonly JsonInput[];
  readonly session?: NavSession;
  readonly reader?: ReviewSourceReader;
  readonly admissionCheck?: AdmissionCheck | null;
}

/** Hydration never writes descriptions or source evidence. Missing stores are not created. */
export const fetchCurrentAdTexts = (options: FetchCurrentAdTextsOptions) => Effect.gen(function* () {
  const { candidates, manifest } = options;

  if (candidates.length > 20) return yield* failure("full_text_batch_exceeds_candidate_limit");

  if (!candidates.length) return Schema.decodeUnknownSync(AdTextBatch)({ available: [], unavailable: [], request_count: 0 });

  if (!Array.isArray(manifest.candidates)) return yield* failure("source_manifest_invalid");

  const manifestById = new Map<string, SourceObject>();

  for (const raw of manifest.candidates) {
    const item = asObject(raw);

    if (!item || !Predicate.isString(item.id) || manifestById.has(item.id)) return yield* failure("source_manifest_invalid");

    manifestById.set(item.id, item);
  }

  const selected: SourceObject[] = [];
  const ids = new Set<string>();

  for (const raw of candidates) {
    const candidate = asObject(raw);

    if (!candidate || !Predicate.isString(candidate.id) || ids.has(candidate.id)) return yield* failure("candidate_batch_invalid");

    ids.add(candidate.id); selected.push(candidate);
  }

  for (const candidate of selected) {
    const entry = manifestById.get(text(candidate.id));

    if (!entry || candidate.version !== entry.version) return yield* failure("candidate_not_in_source_manifest");
  }

  const client = options.session ?? (yield* (yield* NavClient).session({ maxRequests: 21, seconds: 90 }));
  const reader = options.reader ?? reviewSourceReader;
  const { acquireStore, readSnapshot } = yield* Effect.promise(() => import("./store.ts"));
  const sql = yield* acquireStore(options.databasePath, "readonly");

  return yield* readSnapshot(sql, Effect.gen(function* () {
    const includeDetailVersions = yield* reader.hasDetailVersions(sql);
    const available: AdTextBatch["available"][number][] = [];
    const unavailable: AdTextBatch["unavailable"][number][] = [];

    for (const candidate of selected) {
      const id = text(candidate.id);

      if (Either.isLeft(uuid(id))) return yield* failure("invalid_candidate_identity");

      const evidence = yield* reader.readCurrentAd(sql, id, includeDetailVersions);
      const row = evidence.ad;

      if (!row || !evidence.versionExists || row.changed !== candidate.version || evidence.versionChanged !== candidate.version
        || (evidence.detailEvidence !== null && evidence.detailEvidence.saved_changed !== candidate.version)) {
        unavailable.push({ listing_id: id, reason: "source_version_changed", sub_reason: null }); continue;
      }

      const reply = yield* client.get("/api/v1/feedentry/" + id, "detail").pipe(Effect.either);

      if (Either.isLeft(reply)) {
        if (reply.left.transient) return yield* failure("source_temporary");

        unavailable.push({ listing_id: id, reason: "source_fetch_failed", sub_reason: null }); continue;
      }

      const detail = reply.right[0];

      const listing = sourceListing(row, evidence.detailEvidence, { ...evidence,
        geographyEvidenceDigest: Predicate.isString(manifestById.get(id)?.geography_evidence_digest) ? text(manifestById.get(id)?.geography_evidence_digest) : null });

      const checked = yield* checkSourceVersion(listing, detail, { now: new Date(yield* Clock.currentTimeMillis), admissionCheck: options.admissionCheck ?? null });

      if (!checked.would_review || checked.body === null || checked.snapshot === null || checked.snapshot_id === null) {
        unavailable.push({ listing_id: id, reason: checked.sub_reason === "source_text_too_large" ? "source_text_too_large" : "source_text_unavailable", sub_reason: checked.sub_reason }); continue;
      }

      available.push({ listing_id: id, source_version: text(candidate.version), text: checked.body, fingerprint: sha256(checked.body),
        byte_count: new TextEncoder().encode(checked.body).length, provenance: checked.provenance, snapshot: checked.snapshot,
        snapshot_id: checked.snapshot_id, detail_changed: text(clock(detail?.sistEndret)) });
    }

    return Schema.decodeUnknownSync(AdTextBatch)({ available, unavailable, request_count: client.requests });
  }));
}).pipe(Effect.scoped, Effect.mapError((error) => error instanceof SourceError && error.code ? error : failure("source_text_fetch_failed")));
