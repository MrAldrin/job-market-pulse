import { Effect, Either } from "effect";
import { RequestProvenance, ReviewStage, type StageInput } from "../../contracts/judge-state.ts";
import { decodeReview, decodeTitleScreen, validateGeneratedReviewObject, validateReview, validateTitleScreen, type ValidatedAssessment, type ValidatedTitleScreenAssessment } from "../filter/review.ts";
import { pythonJson, type PythonJson } from "../shared/python-json.ts";
import { reviewListingMaterial, reviewMaterialFingerprint, reviewTermsFingerprint } from "../filter/stage-fingerprint.ts";
import { validateManifestContext, transitionAttempt } from "./attempts.ts";
import { fingerprint, instant, REJUDGE_STAGE_VERSION, utcText } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { actualReviewContext, savedResultContext, saveResultContext } from "./history-context.ts";
import { stageInputFingerprint, type ManifestProjection } from "./inputs.ts";
import { parseSnapshotProvenance, snapshotBindingId, validateSnapshotAdmission } from "./provenance.ts";
import { readRun } from "./runs.ts";
import { JudgeIds, decodeStored, requireInitialized, sqlError, write, type JudgeSession } from "./session.ts";
import { attemptInputs, decodeResult, jsonProperty, readAttempt, resultsForAttempt, ResultRow, type StoredStageResult } from "./stored.ts";

export interface RecordBatchOptions {
  readonly stage: ReviewStage;
  readonly submitted_manifest: ManifestProjection;
  readonly current_manifest: ManifestProjection;
  // Encoded JSON values retain integer tokens. Generated reuse has a separate entry.
  readonly raw: PythonJson;
  readonly now: bigint;
  readonly max_age_micros?: bigint;
  readonly current_source_text_fingerprints?: ReadonlyMap<string, string>;
  readonly review_source_material?: ReadonlyMap<string, string> | undefined;
  readonly provenance?: RequestProvenance;
}

export type PersonalInputBinding = Pick<ManifestProjection, "profile_fingerprint" | "preferences_fingerprint" | "rules_fingerprint" | "scoring_version">;

export const validateCurrentManifest = (profileId: string, submitted: PersonalInputBinding, current: ManifestProjection, now: bigint, maxAgeMicros: bigint) => Either.gen(function* () {
  const checked = yield* instant(current.checked_at);
  const age = now - checked;

  if (!current.caught_up || age < 0n || age > maxAgeMicros) return yield* Either.left(new JudgeStateError({ message: "Current source snapshot is stale or incomplete" }));

  if (current.profile_id !== profileId || current.profile_fingerprint !== submitted.profile_fingerprint || current.preferences_fingerprint !== submitted.preferences_fingerprint || current.rules_fingerprint !== submitted.rules_fingerprint || current.scoring_version !== submitted.scoring_version) {
    return yield* Either.left(new JudgeStateError({ message: "Profile or rules changed during review" }));
  }
});

interface SavedAssessment {
  readonly id: string;
  readonly version: string;
  readonly value: Readonly<Record<string, PythonJson>>;
}

const titleAssessment = (row: ValidatedTitleScreenAssessment): SavedAssessment => ({ id: row.id, version: row.version, value: row });

const fullAssessment = (row: ValidatedAssessment): SavedAssessment => {
  const { id, version, fit, reason, evidence, uncertainties, hard_constraints, ad_text_reviewed, assessed_at } = row;

  return { id, version, value: { id, version, fit, reason, evidence, uncertainties, hard_constraints, ad_text_reviewed, assessed_at } };
};

const exactIds = (actual: Iterable<string>, expected: ReadonlySet<string>) => {
  const found = new Set(actual);

  return found.size === expected.size && [...found].every((id) => expected.has(id));
};

const recordBatchCore = (session: JudgeSession, attemptId: string, options: RecordBatchOptions, reused?: ReadonlyMap<string, StoredStageResult>) => Effect.gen(function* () {
  yield* requireInitialized(session);
  yield* decodeStored(ReviewStage, options.stage);
  const attempt = yield* readAttempt(session, attemptId);

  if (attempt.stage !== options.stage) return yield* new JudgeStateError({ message: "Attempt stage does not match result type" });

  const response = fingerprint(options.raw);

  if (attempt.status === "completed") {
    const existing = yield* resultsForAttempt(session, attempt.attempt_id);
    const rows = yield* session.sql<{ response_fingerprint: string | null }>`SELECT response_fingerprint FROM stage_attempts WHERE attempt_id=${attempt.attempt_id}`;

    if (existing.length === attempt.candidate_ids.length && rows[0]?.response_fingerprint === response) return existing;

    return yield* new JudgeStateError({ message: "Completed stage result cannot be overwritten" });
  }

  const requiredStatus = reused === undefined ? "running" : "pending";

  if (attempt.status !== requiredStatus) return yield* new JudgeStateError({ message: reused === undefined ? "Only a running attempt can accept a result" : "Only a pending attempt can accept reuse" });

  if (options.submitted_manifest.manifest_id !== attempt.manifest_id) return yield* new JudgeStateError({ message: "Submitted manifest differs from the claimed attempt" });

  const run = yield* readRun(session, attempt.run_id);
  yield* validateManifestContext(session, options.submitted_manifest, run.context, false);
  yield* validateCurrentManifest(session.profile_id, options.submitted_manifest, options.current_manifest, options.now, options.max_age_micros ?? 86_400_000_000n);

  // Keep the frozen validation point: after attempt/idempotency and current
  // binding checks, before provenance side effects and the result transaction.
  const age = options.max_age_micros ?? 86_400_000_000n;

  const validation = options.stage === "title_screen"
    ? Either.map(Either.flatMap(decodeTitleScreen(options.raw), (screen) => validateTitleScreen(options.submitted_manifest, screen, options.now, age)), (rows) => rows.map(titleAssessment))
    : Either.map(reused === undefined
      ? Either.flatMap(decodeReview(options.raw), (review) => validateReview(options.submitted_manifest, review, options.now, age))
      : validateGeneratedReviewObject(options.submitted_manifest, options.raw, options.now, age), (rows) => rows.map(fullAssessment));

  const validated = yield* Either.mapLeft(validation, (cause) => new JudgeStateError({ message: cause.message, cause }));

  if (new TextEncoder().encode(pythonJson(options.raw, false)).byteLength > 2_000_000) return yield* new JudgeStateError({ message: "Stage result exceeds the JSON size bound" });

  const expected = new Set(attempt.candidate_ids);
  const current = new Map(options.current_manifest.candidates.map((candidate) => [candidate.id, candidate]));
  const submitted = new Map(options.submitted_manifest.candidates.map((candidate) => [candidate.id, candidate]));

  if (!exactIds(validated.map((row) => row.id), expected) || validated.length !== expected.size || !exactIds(current.keys(), expected)) {
    return yield* new JudgeStateError({ message: "Stage result/current source do not cover the exact claimed batch" });
  }

  const inputs = yield* attemptInputs(session, attempt.attempt_id);
  const items = new Map<string, StageInput>(inputs.map((input) => [input.listing_id, input]));

  if (options.stage === "full_review") {
    for (const item of inputs) {
      const candidate = submitted.get(item.listing_id);

      const admission = Either.gen(function* () {
        if (!candidate) return yield* Either.left(new JudgeStateError({ message: "Submitted candidate is missing" }));

        const parsed = yield* parseSnapshotProvenance(item.snapshot_provenance_json);
        yield* validateSnapshotAdmission(parsed, candidate.version, candidate.expires_at);

        return parsed?.format_version === 1 && parsed.expires_at !== null && (yield* instant(parsed.expires_at)) <= options.now;
      });

      if (Either.isLeft(admission)) {
        yield* transitionAttempt(session, attempt.attempt_id, { status: "blocked", now: options.now, error_code: "source_binding_changed" });

        return yield* new JudgeStateError({ message: "Snapshot provenance is invalid", cause: admission.left });
      }

      if (admission.right) {
        yield* transitionAttempt(session, attempt.attempt_id, { status: "blocked", now: options.now, error_code: "detail_inactive", sub_reason: "detail_inactive" });

        return yield* new JudgeStateError({ message: "detail_inactive" });
      }
    }
  }

  for (const identity of expected) {
    const item = items.get(identity);
    const candidate = current.get(identity);

    if (!item || !candidate) return yield* new JudgeStateError({ message: "Candidate is no longer currently eligible" });

    if (item.source_text_fingerprint !== null) {
      const text = options.current_source_text_fingerprints?.get(identity);

      if (text !== undefined && text !== item.source_text_fingerprint) return yield* new JudgeStateError({ message: "Current ad-text fingerprint changed" });

      if (text === undefined && candidate.version !== item.source_version) return yield* new JudgeStateError({ message: "Changed source needs a current ad-text fingerprint" });
    }

    const snapshot = yield* snapshotBindingId(item.snapshot_provenance_json, candidate.version);
    const currentFingerprint = yield* stageInputFingerprint(options.current_manifest, candidate, options.stage, attempt.prompt_version, item.source_text_fingerprint, snapshot, item.upstream_result_id);

    if (currentFingerprint !== item.input_fingerprint) return yield* new JudgeStateError({ message: "Candidate stage inputs changed during review" });
  }

  const at = yield* utcText(options.now);
  const provenance = options.provenance === undefined ? null : yield* decodeStored(RequestProvenance, options.provenance);

  if (provenance !== null && provenance.call_count < attempt.provenance.call_count) return yield* new JudgeStateError({ message: "Attempt call count cannot decrease" });

  return yield* write(session, Effect.gen(function* () {
    const live = yield* readAttempt(session, attempt.attempt_id);

    if (live.status !== requiredStatus) return yield* new JudgeStateError({ message: "Attempt changed before result commit" });

    const results: StoredStageResult[] = [];

    for (const row of validated) {
      const input = items.get(row.id);
      const candidate = submitted.get(row.id);
      const earlier = reused?.get(row.id);

      if (!input || !candidate || (reused !== undefined && !earlier)) return yield* new JudgeStateError({ message: "Validated result has no claimed input" });

      const value = earlier === undefined ? row.value : { ...row.value, assessed_at: jsonProperty(earlier.value, "assessed_at") };
      const previous = yield* session.sql<{ result_id: string }>`SELECT result_id FROM stage_results WHERE listing_id=${row.id} AND stage=${options.stage} AND input_fingerprint=${input.input_fingerprint} ORDER BY recorded_at DESC,rowid DESC LIMIT 1`;
      const identity = yield* (yield* JudgeIds).next;
      // The re-judge claim validates the original first result as its upstream.
      const supersedes = attempt.stage_version === REJUDGE_STAGE_VERSION ? input.upstream_result_id : previous[0]?.result_id ?? null;
      const context = (yield* readRun(session, attempt.run_id)).context;
      const resultHash = fingerprint(value);
      yield* session.sql`INSERT INTO stage_results(result_id,attempt_id,listing_id,stage,source_version,input_fingerprint,result_fingerprint,stage_version,prompt_version,profile_fingerprint,preferences_fingerprint,rules_fingerprint,scoring_version,result_json,recorded_at,supersedes_result_id,upstream_result_id)
        VALUES (${identity},${attempt.attempt_id},${row.id},${options.stage},${row.version},${input.input_fingerprint},${resultHash},${attempt.stage_version},${attempt.prompt_version},${context.profile_fingerprint},${context.preferences_fingerprint},${context.rules_fingerprint},${context.scoring_version},${pythonJson(value, false)},${at},${supersedes},${input.upstream_result_id})`;
      const reviewed = options.stage === "full_review" ? yield* parseSnapshotProvenance(input.snapshot_provenance_json) : null;
      const sourceMaterial = options.review_source_material?.get(row.id);

      const reviewContext = earlier === undefined ? { review_terms: reviewTermsFingerprint(options.submitted_manifest) }
        : actualReviewContext(earlier, yield* savedResultContext(session, earlier.result_id));

      const material = sourceMaterial === undefined ? reviewContext : { ...reviewContext, review_source_material: sourceMaterial };

      yield* saveResultContext(session, identity, candidate, {
        reviewed_expiry: reviewed?.format_version === 1 ? reviewed.expires_at : null,
        reviewed_detail_changed: reviewed?.format_version === 1 ? reviewed.refresh?.detail_changed ?? candidate.version : null,
        reviewed_expiry_version: reviewed?.format_version === 1 ? 1 : null,
        reused_from_result_id: earlier?.result_id ?? null,
        review_material: reviewMaterialFingerprint(reviewListingMaterial(candidate), input.source_text_fingerprint),
        ...material,
      });

      if (options.stage === "title_screen") yield* session.sql`UPDATE review_run_candidates SET status=${jsonProperty(value, "outcome") === "screened_out" ? "screened_out" : "screened"},screening_result_id=${identity} WHERE run_id=${attempt.run_id} AND listing_id=${row.id}`;
      else yield* session.sql`UPDATE review_run_candidates SET status='completed',full_result_id=${identity} WHERE run_id=${attempt.run_id} AND listing_id=${row.id}`;

      const saved = yield* session.sql`SELECT * FROM stage_results WHERE result_id=${identity}`;
      const savedRecord = yield* decodeResult(yield* decodeStored(ResultRow, saved[0]));
      results.push({ ...savedRecord, stale: false });
    }

    yield* session.sql`UPDATE stage_attempts SET status='completed',completed_at=${at},response_fingerprint=${response} WHERE attempt_id=${attempt.attempt_id}`;

    if (provenance !== null) yield* session.sql`UPDATE stage_attempts SET provider_label=${provenance.provider_label},model_label=${provenance.model_label},reasoning_level=${provenance.reasoning_level},call_count=${provenance.call_count},request_bytes=${provenance.request_bytes},response_bytes=${provenance.response_bytes},input_tokens=${provenance.input_tokens},output_tokens=${provenance.output_tokens} WHERE attempt_id=${attempt.attempt_id}`;

    return results;
  }));
}).pipe(Effect.mapError(sqlError));

export const recordBatch = (session: JudgeSession, attemptId: string, options: RecordBatchOptions) => recordBatchCore(session, attemptId, options);

// Only the real generated-reuse workflow calls this typed-object branch.
export const recordGeneratedReusedFullBatch = (session: JudgeSession, attemptId: string, options: Omit<RecordBatchOptions, "stage">, reused: ReadonlyMap<string, StoredStageResult>) =>
  recordBatchCore(session, attemptId, { ...options, stage: "full_review" }, reused);
