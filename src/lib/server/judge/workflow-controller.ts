import { Clock, Effect, Either, Predicate, Schema } from "effect";
import type { Candidate, CandidateManifest } from "../../contracts/filter.ts";
import type { RequestProvenance, ReviewStage, RunContext, StageInput } from "../../contracts/judge-state.ts";
import { FitLevel } from "../../contracts/reviewer-settings.ts";
import type { AdText } from "../../contracts/source-review.ts";
import { reviewMaterialFingerprint } from "../filter/stage-fingerprint.ts";
import { decodeReview, decodeTitleScreen, validateReview, validateTitleScreen } from "../filter/review.ts";
import { ProfileFiles } from "../profile/files.ts";
import { type PythonJson } from "../shared/python-json.ts";
import { parseStrictContractJson } from "../shared/strict-contract-json.ts";
import { snapshotDigest } from "../source/review-text.ts";
import { claimAttempt, recoverInterruptedAttempts, transitionAttempt } from "./attempts.ts";
import { recordBatch } from "./batches.ts";
import { PERMANENT_MODEL_UNKNOWN, REJUDGE_SCOPE, REJUDGE_STAGE_VERSION, REREVIEW_STAGE_VERSION, instant, isoInstant } from "./core.ts";
import type { JudgeDatabaseHandle } from "./database.ts";
import { diagnostic, recordAttemptDiagnostic, validatorCode } from "./diagnostics.ts";
import { buildStageInputs } from "./inputs.ts";
import { currentManifests, freshJudgeProfile, profileMaxAge, readCanonicalManifest, validateSelectedProfile, type JudgeProfileContext } from "./manifests.ts";
import { beginModelCall } from "./model-log.ts";
import { REJUDGE_PROMPT_VERSION, STAGE_PROMPT_VERSIONS } from "./prompts.ts";
import { parseSnapshotProvenance } from "./provenance.ts";
import { initialReviewOrigin, rejudgeAttemptBlock, savedRejudge } from "./rejudge.ts";
import { attachReusedResult, getSavedResult, matchingFullReview, reusableResult, savedReviewForCandidate } from "./results.ts";
import { recordReusedFullReviews } from "./reuse.ts";
import { disclosureText, reviewerEvent } from "./run-information.ts";
import { autoRetryListingIds, beginRun, closeRun, finishRun, latestOpenRun, readRereviewScope, resumeRun, retryBlockedListingIds, runCandidates } from "./runs.ts";
import { modelSteps, rejudgeOptions, rejudgeReviewer, type ModelSettings, type Reviewer } from "./reviewers.ts";
import { currentSnapshotFromValues } from "./snapshot.ts";
import type { StoredStageResult } from "./stored.ts";
import { hasMatchingPermanentUnknown, latestAttemptForInputs, runProgress } from "./views.ts";
import { WorkflowError } from "./workflow-errors.ts";
import { buildPayload, promptListing } from "./workflow-payload.ts";
import { ReviewSource } from "./workflow-source.ts";
import { checkTextBatch, checkTextBinding, MAX_CANDIDATES_PER_RUN, MAX_MODEL_CALLS_PER_RUN, MAX_OUTPUT_TOKENS_PER_CALL, MAX_RESPONSE_BYTES, normalizeListingIds, PROFILE_TEXT_MAX_BYTES, snapshotProvenance, validateOutputTokenCap, validateRunLimits } from "./workflow-support.ts";

const STAGE_VERSION = "personal-review-stage-v1";

type Event = Readonly<Record<string, PythonJson>>;

type Ads = ReadonlyMap<string, typeof AdText.Type>;

export interface ReviewSessionOptions {
  readonly store: JudgeDatabaseHandle;
  readonly context: JudgeProfileContext;
  readonly reviewer: Reviewer;
  readonly modelSettings?: ModelSettings;
  readonly maxOutputTokens?: number;
  readonly maxCandidates?: number;
  readonly maxCalls?: number;
  readonly listingIds?: readonly string[] | null;
  readonly readOnlySource?: boolean;
  readonly reviewAll?: boolean;
  readonly rereview?: true | readonly string[];
  readonly refreshReview?: boolean;
  readonly rejudge?: boolean;
  readonly host: string;
}

export interface ReviewSubmission {
  readonly harness_label: string;
  readonly provider_label: string;
  readonly model_label: string;
  readonly reasoning_level: string;
}

export interface ReviewUsage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly diagnostics?: Record<string, PythonJson>;
}

interface Prepared {
  readonly stage: ReviewStage;
  readonly manifest: CandidateManifest;
  readonly inputs: readonly StageInput[];
  readonly ids: readonly string[];
  readonly ads: Ads | null;
  readonly fingerprints: ReadonlyMap<string, string> | undefined;
  readonly upstream: ReadonlyMap<string, string> | undefined;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly request_bytes: number;
  readonly prior: string | null;
}

const fail = (code: string) => Effect.fail(new WorkflowError({ code }));
const clock = Clock.currentTimeNanos.pipe(Effect.map((nanos) => nanos / 1000n));
const isFitLevel = Schema.is(FitLevel);
const validUsage = (value: number | null) => value === null || (Number.isInteger(value) && value >= 0 && value <= 1_000_000);
const failedCodes = new Set(["model_response_too_large", "model_token_budget_exceeded", "model_cost_budget_exceeded", "reported_model_mismatch", "unexpected_tool_call", "invalid_model_json", "invalid_model_response"]);
const unknownCodes = new Set([PERMANENT_MODEL_UNKNOWN, "pi_aborted", "pi_call_error", "pi_deferred", "pi_response_error", "pi_stream_limit", "harness_timeout", "harness_call_error", "harness_output_invalid", "provider_temporary"]);

const expiryStatus = (prepared: Prepared, now: bigint): string | null => {
  if (prepared.stage !== "full_review") return null;

  for (const input of prepared.inputs) {
    const parsed = parseSnapshotProvenance(input.snapshot_provenance_json);

    if (Either.isLeft(parsed)) return "source_binding_changed";
    const value = parsed.right;

    if (value?.refresh && value.format_version !== 1) return "source_binding_changed";

    if (value?.expires_at) {
      const expiry = instant(value.expires_at);

      if (Either.isLeft(expiry)) return "source_binding_changed";

      if (expiry.right <= now) return "detail_inactive";
    }
  }

  return null;
};

const sourceMaterial = (manifest: CandidateManifest, ads: Ads | null): ReadonlyMap<string, string> =>
  new Map(manifest.candidates.flatMap((candidate) => {
    const ad = ads?.get(candidate.id);

    return ad === undefined ? [] : [[candidate.id, reviewMaterialFingerprint(promptListing(candidate, ad), ad.fingerprint)]];
  }));

const reuseSnapshotIds = (candidate: Candidate, ad: typeof AdText.Type): ReadonlySet<string> => {
  const snapshot = ad.snapshot;

  if ((["title", "employer", "locations", "occupation_categories"] satisfies readonly (keyof Candidate)[]).some((key) => JSON.stringify(snapshot[key]) !== JSON.stringify(candidate[key]))) return new Set();
  const material = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "geography" && key !== "geography_reason"));
  const plain = snapshotDigest(material, ad.text);
  const geographical = snapshotDigest({ ...material, geography: candidate.geography, geography_reason: candidate.geography_reason }, ad.text);

  return new Set([ad.snapshot_id, ...(Either.isRight(plain) ? [plain.right] : []), ...(Either.isRight(geographical) ? [geographical.right] : [])]);
};

// Validate all caller options, including disclosure inputs, before resource access.
export const prepareReviewSession = (options: Omit<ReviewSessionOptions, "store">) => Either.gen(function* () {
  const limits = yield* validateRunLimits(options.maxCandidates ?? MAX_CANDIDATES_PER_RUN, options.maxCalls ?? MAX_MODEL_CALLS_PER_RUN);
  const outputCap = yield* validateOutputTokenCap(options.maxOutputTokens ?? MAX_OUTPUT_TOKENS_PER_CALL);
  const listingIds = yield* normalizeListingIds(options.listingIds ?? null, limits.maxCandidates);
  const rereviewIds = yield* normalizeListingIds(options.rereview === true ? null : options.rereview ?? null, limits.maxCandidates);
  const rejudge = options.rejudge === true;
  const rereviewScope = rejudge ? REJUDGE_SCOPE : options.rereview === undefined ? null : rereviewIds === null ? "all" : JSON.stringify(rereviewIds);

  if (rejudge && (options.rereview !== undefined || !options.reviewAll || !options.readOnlySource || options.modelSettings === undefined)) return yield* Either.left(new WorkflowError({ code: "invalid_rejudge_scope" }));

  if (options.readOnlySource !== undefined && !Predicate.isBoolean(options.readOnlySource)) return yield* Either.left(new WorkflowError({ code: "invalid_source_access_mode" }));

  if (options.reviewAll !== undefined && !Predicate.isBoolean(options.reviewAll)) return yield* Either.left(new WorkflowError({ code: "invalid_review_all" }));

  if (options.reviewAll && listingIds !== null) return yield* Either.left(new WorkflowError({ code: "review_all_conflicts_with_listing_ids" }));
  const reviewer = options.modelSettings === undefined ? options.reviewer : rejudge ? rejudgeReviewer(options.modelSettings) : options.modelSettings.judge;
  const batchSize = options.modelSettings === undefined ? options.context.profile.full_review_batch_size : reviewer.batch_size;
  const context = { ...options.context, profile: { ...options.context.profile, full_review_batch_size: batchSize } };
  const disclosure = yield* disclosureText(reviewer, { profileId: context.profile.profile_id, host: options.host, maxOutputTokens: outputCap, ...limits, listingIds, readOnlySource: options.readOnlySource ?? false, fullReviewBatchSize: batchSize });

  return { limits, outputCap, listingIds, rereviewIds, rereviewScope, reviewer, batchSize, context, disclosure, rejudge };
});

/** Caller holds the selected profile lock for this session's entire lifetime. */
export const createReviewSession = (options: ReviewSessionOptions) => Effect.gen(function* () {
  const store = options.store;
  const { limits, outputCap, listingIds, rereviewIds, rereviewScope, reviewer, batchSize, context, disclosure, rejudge } = yield* prepareReviewSession(options);
  const stageVersion = rejudge ? REJUDGE_STAGE_VERSION : options.rereview === undefined ? STAGE_VERSION : REREVIEW_STAGE_VERSION;
  const promptFor = (stage: ReviewStage) => rejudge ? REJUDGE_PROMPT_VERSION : STAGE_PROMPT_VERSIONS[stage];
  yield* validateSelectedProfile(store, context.profile);
  let runId: string | null = null;
  let aggregate: CandidateManifest | null = null;
  let manifests: readonly CandidateManifest[] = [];
  let sourceSummary: Event | null = null;
  let pending: { id: string; prepared: Prepared } | null = null;
  let active: { id: string; prepared: Prepared; labels: ReviewSubmission } | null = null;
  let retry: { id: string; prepared: Prepared; status: string } | null = null;
  const skipped = new Set<string>();
  const cache = new Map<string, typeof AdText.Type>();
  const bases = new Map<string, string>();
  const reviewerFor = (stage: ReviewStage) => rejudge ? reviewer : options.modelSettings?.[stage === "title_screen" ? "screen" : "judge"] ?? reviewer;
  const requireRun = () => runId === null ? fail("no_active_run") : Effect.succeed(runId);
  const requireActive = (id: string) => active?.id === id ? Effect.succeed(active) : fail("unexpected_attempt_result");

  const runContext = (count: number): RunContext => {
    if (aggregate === null) throw new Error("Session has no current manifest");

    return { coverage_id: aggregate.coverage_id, source_checked_at: aggregate.checked_at, profile_fingerprint: aggregate.profile_fingerprint, preferences_fingerprint: aggregate.preferences_fingerprint, rules_fingerprint: aggregate.rules_fingerprint, scoring_version: aggregate.scoring_version, candidate_count: count, full_review_batch_size: batchSize };
  };

  const subset = (ids: readonly string[]) => Effect.gen(function* () {
    const profile = yield* freshJudgeProfile(context);
    const current = yield* readCanonicalManifest(profile, yield* clock, { limit: limits.maxCandidates, candidateIds: ids });

    if (current.coverage_id !== aggregate?.coverage_id || current.candidates.length !== ids.length || current.candidates.some((item) => !ids.includes(item.id))) return yield* fail("source_manifest_changed");

    return current;
  }).pipe(Effect.mapError(() => new WorkflowError({ code: "source_manifest_stale" })));

  const inputsFor = (stage: ReviewStage, manifest: CandidateManifest, ads: Ads | null = null, upstream?: ReadonlyMap<string, string>) => Effect.gen(function* () {
    const provenance = yield* snapshotProvenance(ads);

    return yield* buildStageInputs(manifest, { stage, prompt_version: promptFor(stage),
      source_text_fingerprints: new Map([...(ads ?? [])].map(([id, ad]) => [id, ad.fingerprint])),
      upstream_result_ids: upstream ?? new Map(),
      snapshot_provenance: new Map(Object.entries(provenance ?? {})),
    });
  });

  const ready = () => Effect.gen(function* () {
    const progress = yield* runProgress(store, yield* requireRun());

    return { type: "ready" as const, status: progress.status, run_id: runId, eligible_count: progress.eligible_count, candidate_count: progress.candidate_ids.length,
      local_eligible_count: aggregate?.eligible_count ?? 0, completed_count: progress.completed_count, screened_out_count: progress.screened_out_count, model_calls: progress.model_calls, source: sourceSummary } satisfies Event;
  });

  const start = () => Effect.gen(function* () {
    if (pending !== null || active !== null || retry !== null) return yield* fail("request_already_active");
    let now = yield* clock;
    let latest = yield* latestOpenRun(store);

    const openScope = latest === null ? null : yield* readRereviewScope(store, latest.run_id);

    // A refresh or manual re-review can start with Judge again. A second
    // pass reselects current inputs without losing existing attempt guards.
    if (latest !== null && openScope === REJUDGE_SCOPE && (options.refreshReview || rejudge || options.rereview !== undefined)) {
      yield* recoverInterruptedAttempts(store, now, true, latest.run_id);
      yield* closeRun(store, latest.run_id, "stale", now, true);
      latest = null;
    }

    if (latest !== null && latest.context.full_review_batch_size !== batchSize) return yield* fail("full_review_batch_size_mismatch");

    if (latest !== null && openScope !== rereviewScope) {
      return { type: "blocked" as const, status: "open_run_review_scope_mismatch", error_code: "open_run_review_scope_mismatch" } satisfies Event;
    }

    if (latest !== null && listingIds !== null) {
      const saved = yield* runCandidates(store, latest.run_id);

      if (saved.length !== listingIds.length || saved.some((candidate) => !listingIds.includes(candidate.listing_id))) return { type: "blocked" as const, status: "open_run_listing_ids_mismatch", error_code: "open_run_listing_ids_mismatch" } satisfies Event;
    }

    yield* recoverInterruptedAttempts(store, now, true);
    const source = yield* ReviewSource;
    const [fresh] = yield* source.checkFresh(context, now);

    if (options.readOnlySource && !fresh) return { type: "blocked" as const, status: "source_refresh_required", error_code: "source_refresh_required" } satisfies Event;

    if (!options.readOnlySource && (latest === null || !fresh)) {
      const summary = yield* source.refresh(context);
      sourceSummary = { refreshed: true, ready: summary.ready, checked_at: summary.checked_at, http_requests: summary.feed_requests + summary.location_requests + summary.occupation_requests, location_unknown: summary.location_unknown, occupation_pending: summary.occupation_pending };

      if (!summary.ready) return { type: "blocked" as const, status: "source_incomplete", error_code: "feed_not_caught_up", source: sourceSummary } satisfies Event;
      now = yield* clock;
    }

    const current = yield* currentManifests(store, context, now);
    aggregate = current.first;
    manifests = current.batches.length ? current.batches : [current.first];
    const candidates = manifests.flatMap((manifest) => manifest.candidates);

    if (new Set(candidates.map((item) => item.id)).size !== candidates.length) return yield* fail("source_manifest_duplicate_identity");

    if (candidates.length !== aggregate.eligible_count) return yield* fail("source_manifest_coverage_mismatch");

    if (latest !== null) {
      const saved = yield* runCandidates(store, latest.run_id);
      const ids = new Set(saved.map((item) => item.listing_id));
      const resumed = yield* Effect.either(resumeRun(store, latest.run_id, runContext(saved.length), candidates.filter((item) => ids.has(item.id))));

      if (Either.isRight(resumed)) {
        const progress = yield* runProgress(store, latest.run_id);

        if (saved.length > limits.maxCandidates || progress.model_calls > limits.maxCalls) return yield* fail("run_limit_below_existing_progress");
        runId = latest.run_id;

        if (options.reviewAll && !rejudge) for (const id of yield* retryBlockedListingIds(store)) skipped.add(id);

        return yield* ready();
      }

      yield* closeRun(store, latest.run_id, "stale", now, true);
      latest = null;
    }

    const snapshot = yield* currentSnapshotFromValues(store, { manifest: aggregate, candidates, eligible_count: aggregate.eligible_count }, now, { prompt_versions: new Map(Object.entries(STAGE_PROMPT_VERSIONS)) });
    const reviewed = new Set(snapshot.candidates.filter((item) => item.screening_status === "screened_out" || item.full_review_status === "completed" || item.rereview_pending).map((item) => item.listing_id));
    const blocked = options.reviewAll && !rejudge ? yield* retryBlockedListingIds(store) : new Set<string>();
    let selected: readonly Candidate[];

    if (rejudge && options.modelSettings !== undefined) {
      bases.clear();
      const levels = rejudgeOptions(options.modelSettings).levels;

      for (const item of snapshot.candidates) {
        const fit = item.full_review?.["fit"];

        if (!isFitLevel(fit) || !levels.includes(fit) || item.full_review_result_id === null) continue;
        const first = yield* getSavedResult(store, item.full_review_result_id);

        if (first?.stage !== "full_review") return yield* fail("rejudge_initial_review_missing");
        const origin = yield* initialReviewOrigin(store, first);

        if ((yield* savedRejudge(store, origin)) === null) bases.set(item.listing_id, origin.result_id);
      }

      selected = candidates.filter((item) => bases.has(item.id)).slice(0, limits.maxCandidates);
    } else if (rereviewScope !== null) {
      if (rereviewIds?.some((id) => !candidates.some((item) => item.id === id))) return yield* fail("listing_ids_not_eligible");
      const older = new Set(snapshot.candidates.filter((item) => item.older_screening || item.older_review || item.rereview_pending).map((item) => item.listing_id));
      const requested = candidates.filter((item) => older.has(item.id) && (rereviewIds === null || rereviewIds.includes(item.id)));
      selected = requested.filter((item) => !blocked.has(item.id)).slice(0, limits.maxCandidates);

      if (!selected.length && requested.length > 0) return { type: "blocked" as const, status: "rereview_attempts_blocked", error_code: "rereview_attempts_blocked" } satisfies Event;
    } else if (listingIds !== null) {
      if (listingIds.some((id) => !candidates.some((item) => item.id === id))) return yield* fail("listing_ids_not_eligible");

      if (listingIds.some((id) => reviewed.has(id))) return yield* fail("listing_ids_already_reviewed");
      selected = candidates.filter((item) => listingIds.includes(item.id));
    } else selected = candidates.filter((item) => !reviewed.has(item.id) && !blocked.has(item.id)).slice(0, limits.maxCandidates);

    if (!selected.length) return { type: "complete" as const, status: "no_pending_candidates", run_id: null, eligible_count: aggregate.eligible_count, local_eligible_count: aggregate.eligible_count, source: sourceSummary } satisfies Event;
    const run = yield* beginRun(store, runContext(selected.length), selected, now, null, rereviewScope);
    runId = run.run_id;
    const ids = new Set(selected.map((item) => item.id));

    for (const manifest of manifests) {
      for (const candidate of manifest.candidates.filter((item) => ids.has(item.id))) {
        const saved = yield* savedReviewForCandidate(store, manifest, candidate, "title_screen", STAGE_PROMPT_VERSIONS.title_screen, null, null);

        if (saved !== null && (rejudge || rereviewScope === null || !saved.older)) yield* attachReusedResult(store, runId, {
          listing_id: candidate.id, result_id: saved.result.result_id, expected_input_fingerprint: saved.result.input_fingerprint,
          now, current_manifest: manifest, max_age_micros: profileMaxAge(context.profile), reuse_screen_material: true,
        });
      }
    }

    return yield* ready();
  });

  const block = (stage: ReviewStage, manifest: CandidateManifest, inputs: readonly StageInput[], code: string, subReason: string | null = null) => Effect.gen(function* () {
    const claim = yield* claimAttempt(store, yield* requireRun(), { stage, manifest, inputs, stage_version: stageVersion, prompt_version: promptFor(stage), now: yield* clock });

    if (claim.attempt.status === "pending" || claim.attempt.status === "blocked") {
      const transition = { status: "blocked" as const, error_code: code, now: yield* clock };
      yield* transitionAttempt(store, claim.attempt.attempt_id, subReason === null ? transition : { ...transition, sub_reason: subReason });
    }

    for (const input of inputs) skipped.add(input.listing_id);
  });

  const requestEvent = (id: string, prepared: Prepared) => ({ type: "request" as const, reviewer: reviewerEvent(reviewerFor(prepared.stage)), attempt_id: id, run_id: runId, stage: prepared.stage, candidate_count: prepared.ids.length, request_bytes: prepared.request_bytes, max_output_tokens: outputCap, retry_of_attempt_id: prepared.prior, system_prompt: prepared.system_prompt, user_prompt: prepared.user_prompt } satisfies Event);
  const retryEvent = (value: { id: string; prepared: Prepared; status: string }) => ({ type: "retry_confirmation" as const, attempt_id: value.id, run_id: runId, stage: value.prepared.stage, candidate_count: value.prepared.ids.length, status: value.status } satisfies Event);

  const claimRequest = (stage: ReviewStage, initial: CandidateManifest, initialAds: Ads | null = null, upstream?: ReadonlyMap<string, string>, retryOf: string | null = null) => Effect.gen(function* () {
    const id = yield* requireRun();
    let manifest = initial;
    let ads = initialAds;
    let inputs = yield* inputsFor(stage, manifest, ads, upstream);
    const reused = new Set<string>();
    const matches = new Map<string, StoredStageResult>();
    const now = yield* clock;

    for (const input of inputs) {
      if (stage === "title_screen" && retryOf === null) {
        const candidate = manifest.candidates.find((item) => item.id === input.listing_id);
        const earlier = candidate === undefined ? null : yield* savedReviewForCandidate(store, manifest, candidate, stage, STAGE_PROMPT_VERSIONS[stage], null, null);

        if (earlier !== null && (rereviewScope === null || !earlier.older)) {
          yield* attachReusedResult(store, id, { listing_id: input.listing_id, result_id: earlier.result.result_id,
            expected_input_fingerprint: earlier.result.input_fingerprint, now, current_manifest: manifest,
            max_age_micros: profileMaxAge(context.profile), reuse_screen_material: true });
          reused.add(input.listing_id);
          continue;
        }
      }

      const saved = rereviewScope === null ? yield* reusableResult(store, stage, input.listing_id, input.input_fingerprint, now) : null;

      if (saved !== null) {
        yield* attachReusedResult(store, id, { listing_id: input.listing_id, result_id: saved.result_id, expected_input_fingerprint: input.input_fingerprint, now });
        reused.add(input.listing_id);
      } else if (ads !== null && retryOf === null && rereviewScope === null) {
        const candidate = manifest.candidates.find((item) => item.id === input.listing_id);
        const ad = ads.get(input.listing_id);

        if (candidate !== undefined && ad !== undefined) {
          const matched = yield* matchingFullReview(store, candidate, input, { snapshot_ids: reuseSnapshotIds(candidate, ad), detail_changed: ad.detail_changed, source_material: reviewMaterialFingerprint(promptListing(candidate, ad), ad.fingerprint), now });

          if (matched !== null) matches.set(input.listing_id, matched);
        }
      }
    }

    if (matches.size) {
      const reuseManifest = matches.size === inputs.length ? manifest : yield* subset([...matches.keys()]);
      const saved = yield* recordReusedFullReviews(store, id, { manifest: reuseManifest, inputs: inputs.filter((item) => matches.has(item.listing_id)), matched: matches, review_source_material: sourceMaterial(reuseManifest, ads), stage_version: STAGE_VERSION, prompt_version: STAGE_PROMPT_VERSIONS[stage], now, max_age_micros: profileMaxAge(context.profile) });

      for (const item of saved) reused.add(item.listing_id);
    }

    if (reused.size) {
      const remaining = manifest.candidates.filter((item) => !reused.has(item.id)).map((item) => item.id);

      if (!remaining.length) return { type: "progress" as const, status: "reused_result" } satisfies Event;
      manifest = yield* subset(remaining);
    }

    const profileText = yield* (yield* ProfileFiles).read(context.root, context.profile.paths.narrative_file, PROFILE_TEXT_MAX_BYTES).pipe(Effect.mapError(() => new WorkflowError({ code: "profile_unavailable" })));
    let payload;

    while (true) {
      const ids = new Set(manifest.candidates.map((item) => item.id));
      ads = initialAds === null ? null : new Map([...initialAds].filter(([key]) => ids.has(key)));
      inputs = yield* inputsFor(stage, manifest, ads, upstream);
      const built = buildPayload(stage, manifest, profileText, ads, rejudge);

      if (Either.isRight(built)) { payload = built.right; break; }

      if (built.left.code !== "model_request_too_large") return yield* built.left;

      if (manifest.candidates.length === 1) {
        yield* block(stage, manifest, inputs, "model_request_too_large");

        return { type: "progress" as const, status: "model_request_too_large" } satisfies Event;
      }

      manifest = yield* subset(manifest.candidates.slice(0, -1).map((item) => item.id));
    }

    const prepared: Prepared = { stage, manifest, inputs, ids: manifest.candidates.map((item) => item.id), ads, fingerprints: ads === null ? undefined : new Map([...ads].map(([key, ad]) => [key, ad.fingerprint])), upstream, ...payload, prior: retryOf };
    const lookup = { stage, manifest, inputs, stage_version: stageVersion, prompt_version: promptFor(stage) };

    if (rejudge) {
      for (const input of inputs) {
        const error = yield* rejudgeAttemptBlock(store, input);

        if (error !== null) return yield* fail(error);
      }
    } else if (options.reviewAll && retryOf === null && (yield* hasMatchingPermanentUnknown(store, lookup))) return yield* fail(PERMANENT_MODEL_UNKNOWN);

    if (!rejudge && rereviewScope !== null && retryOf === null && (yield* hasMatchingPermanentUnknown(store, { ...lookup, stage_version: STAGE_VERSION }))) return yield* fail(PERMANENT_MODEL_UNKNOWN);
    const previous = yield* latestAttemptForInputs(store, id, lookup);
    let parent = retryOf;

    if (parent !== null && (previous?.attempt_id !== parent || !["unknown", "failed", "blocked"].includes(previous.status))) return yield* fail("retry_attempt_binding_changed");

    if (parent === null && previous !== null && ["unknown", "failed", "blocked"].includes(previous.status)) {
      retry = { id: previous.attempt_id, prepared, status: previous.status };

      if (!options.reviewAll) return retryEvent(retry);
      const automatic = rejudge ? null : yield* autoRetryListingIds(store);

      if (automatic !== null && (previous.status === "blocked" || !prepared.ids.every((key) => automatic.has(key)))) {
        for (const key of prepared.ids) skipped.add(key);
        retry = null;

        return { type: "progress" as const, status: "retry_skipped" } satisfies Event;
      }

      parent = previous.attempt_id;
      retry = null;
    }

    if (previous?.status === "running") return yield* fail("prior_attempt_recovery_required");

    if (previous?.status === "completed") return yield* fail("completed_attempt_result_unavailable");
    const claimOptions = { ...lookup, now: yield* clock, profile_lock_held: true };
    const claim = yield* claimAttempt(store, id, parent === null ? claimOptions : { ...claimOptions, retry_of_attempt_id: parent, owner_confirmed_retry: true });

    if (claim.attempt.status === "completed") {
      for (const result of claim.results) yield* attachReusedResult(store, id, { listing_id: result.listing_id, result_id: result.result_id, expected_input_fingerprint: result.input_fingerprint, now: yield* clock });

      return { type: "progress" as const, status: "reused_result" } satisfies Event;
    }

    if (claim.attempt.status !== "pending") return yield* fail("attempt_not_submit_ready");
    const finalPrepared = { ...prepared, prior: parent };
    pending = { id: claim.attempt.attempt_id, prepared: finalPrepared };

    return requestEvent(pending.id, finalPrepared);
  });

  const nextAction = () => Effect.gen(function* () {
    if (runId === null) return { type: "complete" as const, status: "no_active_run" } satisfies Event;

    if (pending !== null || active !== null) return yield* fail("request_already_active");
    const progress = yield* runProgress(store, runId);

    if (progress.model_calls >= limits.maxCalls) return { type: "budget_exhausted" as const, run_id: runId, model_calls: progress.model_calls, max_model_calls: limits.maxCalls } satisfies Event;

    if (retry !== null) return retryEvent(retry);
    const candidates = (yield* runCandidates(store, runId)).filter((item) => !skipped.has(item.listing_id));
    const screen = candidates.filter((item) => item.status === "pending").slice(0, options.modelSettings?.screen.batch_size ?? limits.maxCandidates);
    const full = candidates.filter((item) => item.status === "screened").slice(0, batchSize);

    if (rejudge && (screen.length || full.some((item) => !bases.has(item.listing_id)))) return yield* fail("rejudge_initial_review_missing");

    if (screen.length && (rereviewScope === null || !full.length)) return yield* claimRequest("title_screen", yield* subset(screen.map((item) => item.listing_id)));

    if (full.length) {
      if (full.some((item) => item.screening_result_id === null)) return yield* fail("full_review_missing_screen_result");
      const upstream = new Map<string, string>();

      for (const item of full) {
        const binding = rejudge ? bases.get(item.listing_id) : item.screening_result_id;

        if (binding !== null && binding !== undefined) upstream.set(item.listing_id, binding);
      }

      const manifest = yield* subset(full.map((item) => item.listing_id));

      for (const item of manifest.candidates) if (cache.get(item.id)?.source_version !== item.version) cache.delete(item.id);
      const missing = manifest.candidates.filter((item) => !cache.has(item.id));

      if (missing.length) {
        const missingManifest = yield* subset(missing.map((item) => item.id));
        const batch = yield* (yield* ReviewSource).fetchTexts(context, missingManifest, missingManifest.candidates);
        yield* checkTextBatch(batch, missing.map((item) => item.id));

        // Validate all available bindings before modifying the cache or recording failures.
        for (const ad of batch.available) {
          const candidate = missing.find((item) => item.id === ad.listing_id);

          if (candidate === undefined) return yield* fail("source_text_binding_invalid");
          yield* checkTextBinding(ad, candidate.version);
        }

        for (const failure of batch.unavailable) {
          const failedManifest = yield* subset([failure.listing_id]);
          const inputs = yield* inputsFor("full_review", failedManifest, null, upstream);
          yield* block("full_review", failedManifest, inputs, failure.reason, failure.sub_reason);
        }

        for (const ad of batch.available) cache.set(ad.listing_id, ad);
      }

      const ads = new Map([...cache].filter(([id]) => full.some((item) => item.listing_id === id)));

      if (!ads.size) return { type: "progress" as const, status: "source_text_unavailable" } satisfies Event;

      return yield* claimRequest("full_review", yield* subset([...ads.keys()]), ads, upstream);
    }

    const finished = yield* finishRun(store, runId, yield* clock);

    if (options.reviewAll && finished.status === "partial") yield* closeRun(store, runId, "superseded", yield* clock, true, true);

    return { type: "complete" as const, ...yield* runProgress(store, runId) } satisfies Event;
  });

  const confirmRetry = (id: string) => Effect.gen(function* () {
    if (retry === null || retry.id !== id) return yield* fail("unexpected_retry_confirmation");
    const prepared = retry.prepared;
    retry = null;
    const expired = expiryStatus(prepared, yield* clock);

    if (expired !== null) {
      for (const key of prepared.ids) skipped.add(key);

      return { type: "progress" as const, status: expired } satisfies Event;
    }

    const manifest = yield* subset(prepared.ids);

    if (prepared.stage === "full_review" && (prepared.ads === null || prepared.fingerprints === undefined || prepared.ids.some((key) => !prepared.ads?.has(key) || !prepared.fingerprints?.has(key)))) return yield* fail("retry_source_text_unavailable");
    const inputs = yield* inputsFor(prepared.stage, manifest, prepared.ads, prepared.upstream);

    if (inputs.length !== prepared.inputs.length || inputs.some((item, index) => item.input_fingerprint !== prepared.inputs[index]?.input_fingerprint)) return yield* fail("retry_input_binding_changed");

    return yield* claimRequest(prepared.stage, manifest, prepared.ads, prepared.upstream, id);
  });

  const skipRetry = (id: string) => Effect.gen(function* () {
    if (retry === null || retry.id !== id) return yield* fail("unexpected_retry_confirmation");

    for (const key of retry.prepared.ids) skipped.add(key);
    retry = null;

    return { type: "progress" as const, status: "retry_skipped" } satisfies Event;
  });

  const provenance = (value: { prepared: Prepared; labels: ReviewSubmission }, usage: ReviewUsage = { input_tokens: null, output_tokens: null }, responseBytes: number | null = null): RequestProvenance => ({ provider_label: value.labels.provider_label, model_label: value.labels.model_label, reasoning_level: value.labels.reasoning_level, call_count: 1, request_bytes: value.prepared.request_bytes, response_bytes: responseBytes, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });

  const submit = (id: string, labels: ReviewSubmission) => Effect.gen(function* () {
    if (pending === null || pending.id !== id) return yield* fail("unexpected_attempt_submission");
    const prepared = pending.prepared;
    const selected = reviewerFor(prepared.stage);

    if (labels.harness_label !== selected.harness || labels.provider_label !== selected.provider || labels.model_label !== selected.model || labels.reasoning_level !== selected.effort) return yield* fail("model_settings_mismatch");
    const progress = yield* runProgress(store, yield* requireRun());

    if (progress.model_calls >= limits.maxCalls) return yield* fail("run_call_limit_reached");
    const now = yield* clock;
    yield* transitionAttempt(store, id, { status: "running", now, provenance: provenance({ prepared, labels }) });
    yield* beginModelCall(store, id, rejudge ? "rejudge" : prepared.stage === "title_screen" ? "screen" : "judge", { harness: selected.harness, provider: selected.provider, model: selected.model, effort: selected.effort }, now);
    active = { id, prepared, labels };
    pending = null;

    return { type: "submitted" as const, attempt_id: id } satisfies Event;
  });

  const markUnknown = (id: string, code: string) => Effect.gen(function* () {
    yield* requireActive(id);
    yield* transitionAttempt(store, id, { status: "unknown", now: yield* clock, error_code: unknownCodes.has(code) ? code : "pi_call_uncertain" });
    active = null;

    return { type: "recorded" as const, status: "unknown" } satisfies Event;
  });

  const markFailed = (id: string, code: string, usage: ReviewUsage = { input_tokens: null, output_tokens: null }) => Effect.gen(function* () {
    const value = yield* requireActive(id);

    if (!validUsage(usage.input_tokens) || !validUsage(usage.output_tokens)) return yield* fail("invalid_reported_usage");
    yield* transitionAttempt(store, id, { status: "failed", now: yield* clock, error_code: failedCodes.has(code) ? code : "invalid_model_response", provenance: provenance(value, usage) });
    active = null;

    return { type: "recorded" as const, status: "failed" } satisfies Event;
  });

  const recordResponse = (id: string, rawText: string, usage: ReviewUsage) => Effect.gen(function* () {
    const value = yield* requireActive(id);
    const now = yield* clock;
    const capture = (branch: string, check?: string) => recordAttemptDiagnostic(store, id, diagnostic({ text: rawText, metadata: { ...usage.diagnostics, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, branch, check: check ?? null }));

    const blocked = (code: string) => Effect.gen(function* () {
      const transition = { status: "blocked" as const, now: yield* clock, error_code: code };
      yield* transitionAttempt(store, id, code === "detail_inactive" ? { ...transition, sub_reason: "detail_inactive" } : transition);
      active = null;

      return { type: "recorded" as const, status: "blocked" } satisfies Event;
    });

    yield* capture("received");
    const expired = expiryStatus(value.prepared, now);

    if (expired !== null) return yield* blocked(expired);

    if (!validUsage(usage.input_tokens) || !validUsage(usage.output_tokens)) {
      yield* capture("usage_invalid");

      return yield* markFailed(id, "model_token_budget_exceeded");
    }

    const bytes = new TextEncoder().encode(rawText).length;

    if (bytes > MAX_RESPONSE_BYTES) {
      yield* capture("response_size");

      return yield* markFailed(id, "model_response_too_large", usage);
    }

    if (usage.output_tokens !== null && usage.output_tokens > outputCap) {
      yield* capture("token_budget");

      return yield* markFailed(id, "model_token_budget_exceeded", usage);
    }

    const parsed = parseStrictContractJson(rawText, MAX_RESPONSE_BYTES);

    if (Either.isLeft(parsed)) {
      yield* capture("json_parse", validatorCode(parsed.left));

      return yield* markFailed(id, "invalid_model_json", usage);
    }

    const raw = { ...parsed.right, assessed_at: yield* isoInstant(now) };
    const current = yield* Effect.either(subset(value.prepared.ids));

    if (Either.isLeft(current)) {
      yield* capture("source_manifest");

      return yield* blocked("source_binding_changed");
    }

    if (current.right.manifest_id !== value.prepared.manifest.manifest_id) {
      yield* capture("source_binding");

      return yield* blocked("source_binding_changed");
    }

    const validation = value.prepared.stage === "title_screen"
      ? Either.flatMap(decodeTitleScreen(raw), (decoded) => validateTitleScreen(current.right, decoded, now, profileMaxAge(context.profile))).pipe(Either.map(() => undefined))
      : Either.flatMap(decodeReview(raw), (decoded) => validateReview(current.right, decoded, now, profileMaxAge(context.profile))).pipe(Either.map(() => undefined));

    if (Either.isLeft(validation)) {
      yield* capture("validation", validatorCode(validation.left));

      return yield* markFailed(id, "invalid_model_response", usage);
    }

    const saved = yield* Effect.either(recordBatch(store, id, { stage: value.prepared.stage, submitted_manifest: value.prepared.manifest, current_manifest: current.right, raw, now, max_age_micros: profileMaxAge(context.profile), current_source_text_fingerprints: value.prepared.fingerprints ?? new Map(), review_source_material: sourceMaterial(value.prepared.manifest, value.prepared.ads), provenance: provenance(value, usage, bytes) }));

    if (Either.isLeft(saved)) {
      yield* capture("persistence", validatorCode(saved.left));

      return yield* blocked(saved.left.message === "detail_inactive" ? "detail_inactive" : "source_binding_changed");
    }

    yield* capture("accepted");
    active = null;

    return { type: "recorded" as const, status: "completed", result_count: saved.right.length } satisfies Event;
  });

  const supersedeRun = (ownerConfirmed: boolean) => Effect.gen(function* () {
    if (!ownerConfirmed) return yield* fail("owner_confirmation_required");
    const id = yield* requireRun();
    yield* closeRun(store, id, "superseded", yield* clock, true, true);
    const progress = yield* runProgress(store, id);
    runId = null;
    pending = null;
    retry = null;
    active = null;

    return { type: "superseded" as const, ...progress } satisfies Event;
  });

  const models = options.modelSettings;

  return {
    configurationEvent: () => Effect.succeed({ type: "configured" as const, profile_id: context.profile.profile_id, reviewer: reviewerEvent(reviewer), model_settings: models === undefined ? null : Object.fromEntries(modelSteps.map((key) => [key, reviewerEvent(models[key])])), max_output_tokens: outputCap, max_candidates: limits.maxCandidates, max_calls: limits.maxCalls, listing_ids: listingIds, disclosure } satisfies Event),
    start, nextAction, confirmRetry, skipRetry, submit, recordResponse, markUnknown, markFailed, supersedeRun, reviewerFor,
    cancelBeforeSubmit: (id: string) => Effect.gen(function* () {
      if (pending?.id !== id) return yield* fail("unexpected_attempt_submission");
      pending = null;

      return { type: "cancelled", status: "not_submitted" } satisfies Event;
    }),
    skippedCandidateIds: (): ReadonlySet<string> => new Set(skipped),
    runId: () => runId,
  };
});
