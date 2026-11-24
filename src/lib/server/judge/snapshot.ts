import { Effect, Either, Schema } from "effect";
import { reviewTermsFingerprint } from "../filter/stage-fingerprint.ts";
import type { SnapshotRejudge } from "../../contracts/snapshot.ts";
import type { ReviewStage } from "../../contracts/judge-state.ts";
import { REREVIEW_STAGE_VERSION, instant, isoInstant } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import type { JudgeDatabaseHandle } from "./database.ts";
import { currentManifests, type JudgeProfileContext } from "./manifests.ts";
import { stageInputFingerprint, type CandidateProjection, type ManifestProjection } from "./inputs.ts";
import { STAGE_PROMPT_VERSIONS } from "./prompts.ts";
import { savedReviewForCandidate } from "./results.ts";
import { decodeStored, sqlError, type JudgeSession } from "./session.ts";
import { StoredJsonObject } from "./stored.ts";

type JsonObject = typeof StoredJsonObject.Type;

export interface PersonalCandidateView {
  readonly listing_id: string;
  readonly source_version: string;
  readonly title: string;
  readonly employer: string;
  readonly locations: readonly string[];
  readonly url: string;
  readonly expires_at: string | null;
  readonly detail_missing: boolean;
  readonly screening_status: string;
  readonly screening: JsonObject | null;
  readonly screening_attempt_status: string;
  readonly older_screening: boolean;
  readonly older_review: boolean;
  readonly rereview_pending: boolean;
  readonly full_review_status: string;
  readonly full_review: JsonObject | null;
  readonly full_review_result_id: string | null;
  readonly full_review_input_fingerprint: string | null;
  readonly review_prompt_version: string | null;
  readonly scoring_version: string;
  readonly profile_fingerprint: string;
  readonly preferences_fingerprint: string;
  readonly rules_fingerprint: string;
  readonly full_review_attempt_status: string;
  readonly recommendable: boolean;
  readonly lifecycle_status: string;
  readonly provenance: string;
  readonly application_due: string | null;
  readonly full_review_blocked_sub_reason: string | null;
  readonly rejudge?: typeof SnapshotRejudge.Type & { readonly reviewed_at: string };
}

export interface PersonalSnapshotView {
  readonly profile_id: string;
  readonly coverage_id: string;
  readonly checked_at: string;
  readonly profile_fingerprint: string;
  readonly preferences_fingerprint: string;
  readonly rules_fingerprint: string;
  readonly scoring_version: string;
  readonly eligible_count: number;
  readonly review_terms: string;
  readonly candidates: readonly PersonalCandidateView[];
  readonly ranked: readonly PersonalCandidateView[];
  readonly screened_out_count: number;
  readonly pending_count: number;
  readonly failed_count: number;
  readonly unknown_attempt_count: number;
  readonly closed: readonly PersonalCandidateView[];
  readonly eligibility_verified: boolean;
}

// Private projections of real canonical manifest/batch values. This function
// does not replace current_manifests or a Source adapter with supplied services.
export interface CurrentSnapshotValues {
  readonly manifest: ManifestProjection;
  readonly candidates: readonly CandidateProjection[];
  readonly eligible_count: number;
}

export interface CurrentSnapshotOptions {
  readonly source_text_fingerprints?: ReadonlyMap<string, string>;
  readonly prompt_versions?: ReadonlyMap<string, string>;
}

const CandidateMetadata = Schema.Struct({ title: Schema.String, employer: Schema.String, locations: Schema.Array(Schema.String), url: Schema.String, detail_missing: Schema.Boolean });
const FullSummary = Schema.Struct({ fit: Schema.String, hard_constraints: Schema.String });
const fitOrder = new Map(["exceptional", "strong", "possible", "poor", "unknown"].map((fit, index) => [fit, index]));

const latestAttemptStatus = (session: JudgeSession, listingId: string, stage: ReviewStage, inputFingerprint: string) => Effect.gen(function* () {
  const rows = yield* session.sql`SELECT a.status FROM stage_attempts a JOIN stage_attempt_candidates c ON c.attempt_id=a.attempt_id WHERE a.profile_id=${session.profile_id} AND a.stage=${stage} AND c.listing_id=${listingId} AND c.input_fingerprint=${inputFingerprint} ORDER BY a.requested_at DESC,a.rowid DESC LIMIT 1`;

  return rows[0] ? (yield* decodeStored(Schema.Struct({ status: Schema.String }), rows[0])).status : "pending";
});

const latestBlockedReason = (session: JudgeSession, listingId: string, inputFingerprint: string) => Effect.gen(function* () {
  const columns = yield* session.sql<{ name: string }>`PRAGMA table_info(stage_attempts)`;

  if (!columns.some((column) => column.name === "blocked_sub_reason")) return null;

  const rows = yield* session.sql`SELECT a.blocked_sub_reason FROM stage_attempts a JOIN stage_attempt_candidates c ON c.attempt_id=a.attempt_id WHERE a.profile_id=${session.profile_id} AND a.stage='full_review' AND c.listing_id=${listingId} AND c.input_fingerprint=${inputFingerprint} ORDER BY a.requested_at DESC,a.rowid DESC LIMIT 1`;

  return rows[0] ? (yield* decodeStored(Schema.Struct({ blocked_sub_reason: Schema.NullOr(Schema.String) }), rows[0])).blocked_sub_reason : null;
});

const candidateBase = (manifest: ManifestProjection, candidate: CandidateProjection): Effect.Effect<PersonalCandidateView, JudgeStateError> => Effect.gen(function* () {
  const metadata = yield* Either.mapLeft(Schema.decodeUnknownEither(CandidateMetadata)(candidate), (cause) => new JudgeStateError({ message: "Saved candidate metadata is invalid", cause }));

  return {
    listing_id: candidate.id, source_version: candidate.version, ...metadata, expires_at: candidate.expires_at,
    screening_status: "pending", screening: null, screening_attempt_status: "pending", older_screening: false, older_review: false, rereview_pending: false,
    full_review_status: "not_eligible", full_review: null, full_review_result_id: null,
    full_review_input_fingerprint: null, review_prompt_version: null,
    scoring_version: manifest.scoring_version, profile_fingerprint: manifest.profile_fingerprint,
    preferences_fingerprint: manifest.preferences_fingerprint, rules_fingerprint: manifest.rules_fingerprint,
    full_review_attempt_status: "not_eligible", recommendable: false,
    lifecycle_status: "saved_source_unconfirmed", provenance: "Validated staged review",
    application_due: null, full_review_blocked_sub_reason: null,
  };
});

const promptFor = (options: CurrentSnapshotOptions, stage: ReviewStage) => {
  const prompt = options.prompt_versions?.size ? options.prompt_versions.get(stage) : STAGE_PROMPT_VERSIONS[stage];

  return prompt === undefined ? Either.left(new JudgeStateError({ message: `Missing prompt version for ${stage}` })) : Either.right(prompt);
};

const currentCandidate = (session: JudgeSession, manifest: ManifestProjection, candidate: CandidateProjection, now: bigint, options: CurrentSnapshotOptions) => Effect.gen(function* () {
  const base = yield* candidateBase(manifest, candidate);
  const titlePrompt = yield* promptFor(options, "title_screen");
  const screenFingerprint = yield* stageInputFingerprint(manifest, candidate, "title_screen", titlePrompt);
  const savedScreen = yield* savedReviewForCandidate(session, manifest, candidate, "title_screen", titlePrompt, null, null);
  const screenRow = savedScreen?.result ?? null;
  const screen = screenRow === null ? null : yield* decodeStored(StoredJsonObject, screenRow.value);
  const outcome = screen?.["outcome"];
  const screenStatus = screen === null ? "pending" : outcome === "screened_out" ? "screened_out" : "advance_to_full_review";
  const screenAttempt = screenRow === null ? yield* latestAttemptStatus(session, candidate.id, "title_screen", screenFingerprint) : "completed";
  const advanced = screenRow !== null && outcome === "advance_to_full_review";
  const fullPrompt = advanced ? yield* promptFor(options, "full_review") : STAGE_PROMPT_VERSIONS.full_review;
  const text = options.source_text_fingerprints?.get(candidate.id) ?? null;
  const savedFull = advanced ? yield* savedReviewForCandidate(session, manifest, candidate, "full_review", fullPrompt, screenRow.result_id, text) : null;
  const fullRow = savedFull?.result ?? null;
  const full = fullRow === null ? null : yield* decodeStored(StoredJsonObject, fullRow.value);
  let fullAttempt = advanced ? "pending" : "not_eligible";
  let subReason: string | null = null;

  if (fullRow !== null) fullAttempt = "completed";
  else if (advanced) {
    const fullFingerprint = yield* stageInputFingerprint(manifest, candidate, "full_review", fullPrompt, text, null, screenRow.result_id);
    fullAttempt = yield* latestAttemptStatus(session, candidate.id, "full_review", fullFingerprint);

    if (fullAttempt === "blocked") subReason = yield* latestBlockedReason(session, candidate.id, fullFingerprint);
  }

  const expiry = savedFull?.expiry === undefined ? candidate.expires_at : savedFull.expiry;
  const expired = savedFull?.expiry != null && (yield* instant(savedFull.expiry)) <= now;

  const summary = full === null ? null : yield* Either.mapLeft(Schema.decodeUnknownEither(FullSummary)(full), (cause) => new JudgeStateError({ message: "Saved full-review summary is missing", cause }));

  return {
    ...base, expires_at: expiry, screening_status: screenStatus, screening: screen,
    screening_attempt_status: screenAttempt, full_review_status: advanced ? fullAttempt : "pending", full_review: full,
    older_screening: savedScreen?.older ?? false, older_review: savedFull?.older ?? false,
    rereview_pending: advanced && fullRow === null && screenRow.stage_version === REREVIEW_STAGE_VERSION && screenRow.source_version === candidate.version,
    full_review_result_id: fullRow?.result_id ?? null, full_review_input_fingerprint: fullRow?.input_fingerprint ?? null,
    review_prompt_version: fullRow?.prompt_version ?? null, full_review_attempt_status: fullAttempt,
    full_review_blocked_sub_reason: subReason,
    recommendable: !expired && summary !== null && ["exceptional", "strong", "possible"].includes(summary.fit) && summary.hard_constraints === "pass",
    lifecycle_status: expired ? "source_expired" : "saved_source_unconfirmed",
  } satisfies PersonalCandidateView;
});

export const currentSnapshotFromValues = (session: JudgeSession, values: CurrentSnapshotValues, now: bigint, options: CurrentSnapshotOptions = {}): Effect.Effect<PersonalSnapshotView, JudgeStateError> => Effect.gen(function* () {
  const manifest = values.manifest;

  if (manifest.profile_id !== session.profile_id) return yield* new JudgeStateError({ message: "Manifest belongs to another profile" });

  const candidates = yield* Effect.forEach(values.candidates, (candidate) => session.initialized ? currentCandidate(session, manifest, candidate, now, options) : candidateBase(manifest, candidate));
  const records = candidates.filter((record) => record.lifecycle_status !== "source_expired");
  const closed = candidates.filter((record) => record.lifecycle_status === "source_expired");

  const ranking = yield* Effect.forEach(records.filter((record) => record.full_review !== null), (record) => Effect.gen(function* () {
    const summary = yield* Either.mapLeft(Schema.decodeUnknownEither(FullSummary)(record.full_review), (cause) => new JudgeStateError({ message: "Saved full-review summary is missing", cause }));
    const order = fitOrder.get(summary.fit);

    if (order === undefined) return yield* new JudgeStateError({ message: "Saved full-review fit is unknown" });

    return { record, order };
  }));

  ranking.sort((left, right) => left.order - right.order || left.record.listing_id.localeCompare(right.record.listing_id));

  return {
    profile_id: session.profile_id, coverage_id: manifest.coverage_id, checked_at: yield* isoInstant(manifest.checked_at),
    profile_fingerprint: manifest.profile_fingerprint, preferences_fingerprint: manifest.preferences_fingerprint,
    rules_fingerprint: manifest.rules_fingerprint, scoring_version: manifest.scoring_version,
    eligible_count: values.eligible_count, review_terms: reviewTermsFingerprint(manifest), candidates: records, ranked: ranking.map((item) => item.record), closed,
    screened_out_count: records.filter((record) => record.screening_status === "screened_out").length,
    pending_count: records.filter((record) => (record.screening_status === "pending" && record.screening_attempt_status === "pending") || (record.screening_status === "advance_to_full_review" && record.full_review === null && record.full_review_attempt_status === "pending")).length,
    failed_count: records.filter((record) => ["failed", "blocked"].includes(record.screening_attempt_status) || ["failed", "blocked"].includes(record.full_review_attempt_status)).length,
    unknown_attempt_count: records.filter((record) => record.screening_attempt_status === "unknown" || record.full_review_attempt_status === "unknown").length,
    eligibility_verified: true,
  };
}).pipe(Effect.mapError(sqlError));

export interface CurrentSnapshotReadOptions extends CurrentSnapshotOptions {
  readonly limit?: number;
}

export const readCurrentSnapshot = (store: JudgeDatabaseHandle, context: JudgeProfileContext, now: bigint, options: CurrentSnapshotReadOptions = {}) => Effect.gen(function* () {
  const { first, batches } = yield* currentManifests(store, context, now, options.limit);

  return yield* currentSnapshotFromValues(store, { manifest: first, candidates: batches.flatMap((batch) => batch.candidates), eligible_count: first.eligible_count }, now, options);
});
