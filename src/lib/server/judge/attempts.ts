import { Effect, Either, Schema } from "effect";
import { BlockedSubReason, Label, RequestProvenance, StageInput, emptyProvenance, type AttemptStatus, ReviewStage, type RunContext } from "../../contracts/judge-state.ts";
import { MAX_MODEL_CALLS_PER_RUN, PROFILE_CALL_WINDOW_MICROS, REJUDGE_STAGE_VERSION, batchFingerprint, fingerprint, instant, isOpenRun, isTerminalAttempt, normalizeIdentity, utcText } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { stageInputFingerprint, type ManifestProjection } from "./inputs.ts";
import { parseSnapshotProvenance, snapshotBindingId, validateSnapshotAdmission } from "./provenance.ts";
import { validateRejudgeOrigin } from "./rejudge.ts";
import { readRun } from "./runs.ts";
import { JudgeIds, decodeStored, requireInitialized, sqlError, write, type JudgeSession } from "./session.ts";
import { ResultRow, decodeResult, jsonProperty, readAttempt, resultsForAttempt } from "./stored.ts";
import { strip } from "../shared/text.ts";
import { candidateJson } from "../filter/manifest.ts";

import { STAGE_PROMPT_VERSIONS } from "./prompts.ts";
import { matchesReviewMaterial, savedResultContext } from "./history-context.ts";

export const validateManifestContext = (session: JudgeSession, manifest: ManifestProjection, context: RunContext, checkCoverage = true) => {
  if (manifest.profile_id !== session.profile_id) return Either.left(new JudgeStateError({ message: "Manifest belongs to another profile" }));

  if (manifest.profile_fingerprint !== context.profile_fingerprint || manifest.preferences_fingerprint !== context.preferences_fingerprint || manifest.rules_fingerprint !== context.rules_fingerprint || manifest.scoring_version !== context.scoring_version) {
    return Either.left(new JudgeStateError({ message: "Manifest personal inputs differ from the run" }));
  }

  if (checkCoverage && manifest.coverage_id !== context.coverage_id) return Either.left(new JudgeStateError({ message: "Manifest coverage differs from the run" }));

  return Either.void;
};

export const validateUpstreamScreen = (session: JudgeSession, listingId: string, resultId: string | null, manifest: ManifestProjection, candidate: ManifestProjection["candidates"][number], acceptedInRun: string | null) => Effect.gen(function* () {
  if (resultId === null) return yield* new JudgeStateError({ message: "Full review must bind a screening result" });

  const selected = yield* normalizeIdentity(resultId);
  const rows = yield* session.sql`SELECT s.* FROM stage_results s JOIN stage_attempts a ON a.attempt_id=s.attempt_id WHERE s.result_id=${selected} AND a.profile_id=${session.profile_id} AND a.status='completed'`;

  if (!rows[0]) return yield* new JudgeStateError({ message: "Full review needs a current accepted advance screening result" });

  const row = yield* decodeResult(yield* decodeStored(ResultRow, rows[0]));

  const expected = yield* stageInputFingerprint(manifest, candidate, "title_screen", STAGE_PROMPT_VERSIONS.title_screen);

  const compatible = row.input_fingerprint === expected
    || (row.result_id === acceptedInRun && matchesReviewMaterial(row, yield* savedResultContext(session, row.result_id), manifest, candidate, null, null));

  if (row.stage !== "title_screen" || row.listing_id !== listingId || !compatible || jsonProperty(row.value, "outcome") !== "advance_to_full_review") {
    return yield* new JudgeStateError({ message: "Full review needs a current accepted advance screening result" });
  }
});

export interface ClaimOptions {
  readonly stage: ReviewStage;
  readonly manifest: ManifestProjection;
  readonly inputs: readonly StageInput[];
  readonly stage_version: string;
  readonly prompt_version: string;
  readonly now: bigint;
  readonly retry_of_attempt_id?: string;
  readonly owner_confirmed_retry?: boolean;
  readonly profile_lock_held?: boolean;
  readonly provenance?: RequestProvenance;
}

export const claimAttempt = (session: JudgeSession, runId: string, options: ClaimOptions) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const at = yield* utcText(options.now);
  yield* decodeStored(ReviewStage, options.stage);
  const stageVersion = strip(yield* decodeStored(Label, options.stage_version));
  const promptVersion = strip(yield* decodeStored(Label, options.prompt_version));
  const run = yield* readRun(session, runId);

  if (run.status !== "running" && run.status !== "partial") return yield* new JudgeStateError({ message: "Review run is not open for attempts" });

  if (options.inputs.length < 1 || options.inputs.length > 120) return yield* new JudgeStateError({ message: "Stage batch must contain 1 to 120 candidates" });

  yield* validateManifestContext(session, options.manifest, run.context);
  const normalized: StageInput[] = [];
  const identities = new Set<string>();

  for (const input of options.inputs) {
    const identity = yield* normalizeIdentity(input.listing_id);
    const item = yield* decodeStored(StageInput, { ...input, listing_id: identity });
    const candidate = options.manifest.candidates.find((candidate) => candidate.id === identity);

    if (identities.has(identity)) return yield* new JudgeStateError({ message: "Stage batch candidate IDs must be unique" });

    identities.add(identity);

    if (!candidate || candidate.version !== item.source_version) return yield* new JudgeStateError({ message: "Stage input does not match its manifest" });

    if (options.stage === "full_review") {
      const parsed = yield* parseSnapshotProvenance(item.snapshot_provenance_json);
      yield* validateSnapshotAdmission(parsed, candidate.version, candidate.expires_at);

      if (parsed?.format_version === 1 && parsed.expires_at !== null && (yield* instant(parsed.expires_at)) <= options.now) {
        return yield* new JudgeStateError({ message: "detail_inactive" });
      }
    }

    const snapshotId = yield* snapshotBindingId(item.snapshot_provenance_json, candidate.version);
    const expected = yield* stageInputFingerprint(options.manifest, candidate, options.stage, promptVersion, item.source_text_fingerprint, snapshotId, item.upstream_result_id);

    if (expected !== item.input_fingerprint) return yield* new JudgeStateError({ message: "Stage input fingerprint does not match inputs" });

    const saved = yield* session.sql<{ source_version: string; candidate_fingerprint: string; screening_result_id: string | null }>`SELECT source_version,candidate_fingerprint,screening_result_id FROM review_run_candidates WHERE run_id=${run.run_id} AND listing_id=${identity}`;

    if (!saved[0] || saved[0].source_version !== item.source_version) return yield* new JudgeStateError({ message: "Stage candidate is not in the saved run" });

    if (saved[0].candidate_fingerprint !== fingerprint(candidateJson(candidate))) return yield* new JudgeStateError({ message: "Stage candidate snapshot changed" });

    if (stageVersion === REJUDGE_STAGE_VERSION) {
      if (options.stage !== "full_review") return yield* new JudgeStateError({ message: "Re-judge is a full assessment" });
      const screen = saved[0].screening_result_id;
      yield* validateUpstreamScreen(session, identity, screen, options.manifest, candidate, screen);
      yield* validateRejudgeOrigin(session, item, screen);
    } else if (options.stage === "full_review") yield* validateUpstreamScreen(session, identity, item.upstream_result_id, options.manifest, candidate, saved[0].screening_result_id);

    normalized.push(item);
  }

  const provenance = yield* decodeStored(RequestProvenance, options.provenance ?? emptyProvenance);
  const batch = batchFingerprint(options.stage, stageVersion, promptVersion, normalized);

  return yield* write(session, Effect.gen(function* () {
    const current = yield* readRun(session, run.run_id);

    if (current.status !== "running" && current.status !== "partial") return yield* new JudgeStateError({ message: "Review run closed before attempt claim" });

    const previousRows = yield* session.sql<{ attempt_id: string }>`SELECT attempt_id FROM stage_attempts WHERE profile_id=${session.profile_id} AND stage=${options.stage} AND input_fingerprint=${batch} AND (${options.profile_lock_held === true ? 1 : 0} OR run_id=${run.run_id}) ORDER BY rowid DESC LIMIT 1`;
    const previous = previousRows[0] ? yield* readAttempt(session, previousRows[0].attempt_id) : null;
    let retryId: string | null = null;
    let number = 1;

    if (options.retry_of_attempt_id !== undefined) {
      retryId = yield* normalizeIdentity(options.retry_of_attempt_id);

      if (options.owner_confirmed_retry !== true) return yield* new JudgeStateError({ message: "Explicit owner confirmation is required to retry" });

      if (options.profile_lock_held !== true) return yield* new JudgeStateError({ message: "Retry requires profile lock confirmation" });

      if (previous !== null && previous.run_id === run.run_id && previous.retry_of_attempt_id === retryId) {
        return { attempt: previous, created: false, results: yield* resultsForAttempt(session, previous.attempt_id) };
      }

      const parent = yield* readAttempt(session, retryId);

      if (previous === null || previous.attempt_id !== retryId || parent.stage !== options.stage || parent.input_fingerprint !== batch || !isTerminalAttempt(parent.status)) {
        return yield* new JudgeStateError({ message: "Retry must link to a matching terminal attempt" });
      }

      if (parent.run_id !== run.run_id && isOpenRun((yield* readRun(session, parent.run_id)).status)) {
        return yield* new JudgeStateError({ message: "Cross-run retry requires the profile lock and a closed prior run" });
      }

      number = parent.attempt_number + 1;
    } else if (previous !== null) {
      return { attempt: previous, created: false, results: yield* resultsForAttempt(session, previous.attempt_id) };
    }

    const identity = yield* (yield* JudgeIds).next;
    yield* session.sql`INSERT INTO stage_attempts(attempt_id,run_id,profile_id,stage,status,input_fingerprint,manifest_id,stage_version,prompt_version,attempt_number,retry_of_attempt_id,requested_at,completed_at,error_code,provider_label,model_label,reasoning_level,call_count,request_bytes,response_bytes)
      VALUES (${identity},${run.run_id},${session.profile_id},${options.stage},'pending',${batch},${options.manifest.manifest_id},${stageVersion},${promptVersion},${number},${retryId},${at},NULL,NULL,${provenance.provider_label},${provenance.model_label},${provenance.reasoning_level},0,${provenance.request_bytes},NULL)`;

    for (const item of normalized) {
      yield* session.sql`INSERT INTO stage_attempt_candidates(attempt_id,listing_id,source_version,input_fingerprint,source_text_fingerprint,upstream_result_id,snapshot_provenance_json) VALUES (${identity},${item.listing_id},${item.source_version},${item.input_fingerprint},${item.source_text_fingerprint},${item.upstream_result_id},${item.snapshot_provenance_json})`;
    }

    return { attempt: yield* readAttempt(session, identity), created: true, results: [] };
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export interface TransitionOptions {
  readonly status: Exclude<AttemptStatus, "pending" | "completed">;
  readonly now: bigint;
  readonly error_code?: string;
  readonly provenance?: RequestProvenance;
  readonly sub_reason?: string;
}

export const transitionAttempt = (session: JudgeSession, attemptId: string, options: TransitionOptions) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const identity = yield* normalizeIdentity(attemptId);
  yield* decodeStored(Schema.Literal("running", "failed", "blocked", "unknown"), options.status);
  const at = yield* utcText(options.now);
  const errorCode = options.error_code ?? null;
  const subReason = options.sub_reason ?? null;

  if (errorCode !== null && !/^[a-z0-9_]{1,64}(?![\s\S])/.test(errorCode)) return yield* new JudgeStateError({ message: "Attempt error code must be a safe category" });

  if (subReason !== null && (options.status !== "blocked" || !Schema.is(BlockedSubReason)(subReason))) {
    return yield* new JudgeStateError({ message: "Attempt sub-reason must be a known category" });
  }

  const provenance = options.provenance === undefined ? null : yield* decodeStored(RequestProvenance, options.provenance);

  return yield* write(session, Effect.gen(function* () {
    const attempt = yield* readAttempt(session, identity);
    const run = yield* readRun(session, attempt.run_id);

    if (provenance !== null && provenance.call_count < attempt.provenance.call_count) return yield* new JudgeStateError({ message: "Attempt call count cannot decrease" });

    if (options.status === "running") {
      if (!isOpenRun(run.status)) return yield* new JudgeStateError({ message: "Review run is not open for model calls" });

      const next = provenance?.call_count ?? 1;

      if (next < 1) return yield* new JudgeStateError({ message: "A submitted attempt must record at least one call" });

      const rows = yield* session.sql<{ calls: number }>`SELECT COALESCE(SUM(call_count),0) AS calls FROM stage_attempts WHERE run_id=${run.run_id}`;

      if ((rows[0]?.calls ?? 0) + next > MAX_MODEL_CALLS_PER_RUN) return yield* new JudgeStateError({ message: "Per-run model call budget is exhausted" });
    }

    const refresh = attempt.status === "blocked" && options.status === "blocked" && attempt.error_code === errorCode && attempt.blocked_sub_reason !== subReason && provenance === null;

    if (isTerminalAttempt(attempt.status) && !refresh) {
      if (attempt.status === options.status && attempt.error_code === errorCode && attempt.blocked_sub_reason === subReason) return attempt;

      return yield* new JudgeStateError({ message: "Terminal attempt cannot be overwritten" });
    }

    if (options.status === "running" && attempt.status !== "pending") return yield* new JudgeStateError({ message: "Only a pending attempt can be submitted" });

    if (options.status !== "running" && attempt.status !== "pending" && attempt.status !== "running" && !refresh) return yield* new JudgeStateError({ message: "Invalid attempt status transition" });

    yield* session.sql`UPDATE stage_attempts SET status=${options.status},error_code=${errorCode} WHERE attempt_id=${identity}`;

    if (options.status === "running") yield* session.sql`UPDATE stage_attempts SET submitted_at=${at} WHERE attempt_id=${identity}`;
    else yield* session.sql`UPDATE stage_attempts SET completed_at=${at} WHERE attempt_id=${identity}`;

    if (options.status === "blocked") yield* session.sql`UPDATE stage_attempts SET blocked_sub_reason=${subReason} WHERE attempt_id=${identity}`;

    if (provenance === null && options.status === "running") yield* session.sql`UPDATE stage_attempts SET call_count=1 WHERE attempt_id=${identity}`;

    if (provenance !== null) yield* session.sql`UPDATE stage_attempts SET provider_label=${provenance.provider_label},model_label=${provenance.model_label},reasoning_level=${provenance.reasoning_level},call_count=${provenance.call_count},request_bytes=${provenance.request_bytes},response_bytes=${provenance.response_bytes},input_tokens=${provenance.input_tokens},output_tokens=${provenance.output_tokens} WHERE attempt_id=${identity}`;

    return yield* readAttempt(session, identity);
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const recoverInterruptedAttempts = (session: JudgeSession, now: bigint, profileLockHeld: boolean, runId: string | null = null) => Effect.gen(function* () {
  yield* requireInitialized(session);

  if (profileLockHeld !== true) return yield* new JudgeStateError({ message: "Profile lock confirmation is required for recovery" });

  const selectedRun = runId === null ? null : yield* normalizeIdentity(runId);
  const at = yield* utcText(now);

  return yield* write(session, Effect.gen(function* () {
    if (selectedRun !== null) yield* readRun(session, selectedRun);

    const rows = yield* session.sql<{ attempt_id: string }>`SELECT attempt_id FROM stage_attempts WHERE profile_id=${session.profile_id} AND status='running' AND (${selectedRun} IS NULL OR run_id=${selectedRun}) ORDER BY requested_at,rowid`;
    const recovered = [];

    for (const row of rows) {
      yield* session.sql`UPDATE stage_attempts SET status='unknown',completed_at=${at},error_code='interrupted_unknown' WHERE profile_id=${session.profile_id} AND status='running' AND attempt_id=${row.attempt_id}`;
      recovered.push(yield* readAttempt(session, row.attempt_id));
    }

    return recovered;
  }));
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : sqlError(cause)));

export const profileCallsInWindow = (session: JudgeSession, now: bigint) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const since = yield* utcText(now - PROFILE_CALL_WINDOW_MICROS);
  const rows = yield* session.sql<{ calls: number }>`SELECT COALESCE(SUM(call_count),0) AS calls FROM stage_attempts WHERE profile_id=${session.profile_id} AND COALESCE(submitted_at,requested_at)>${since}`;

  return rows[0]?.calls ?? 0;
}).pipe(Effect.mapError(sqlError));
