import { Effect, Either, Predicate, Schema } from "effect";
import { FitLevel } from "../../contracts/reviewer-settings.ts";
import type { RunFilters, RunPool } from "../../contracts/snapshot.ts";
import { instant, isoInstant, REJUDGE_STAGE_VERSION } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { actualReviewContext, historicalResult, historicalRows, savedResultContext, type HistoricalResult } from "./history-context.ts";
import { sourceLifecycle, type HistoryLifecycleOptions, type HistorySourceFacts } from "./history-lifecycle.ts";
import { initialReviewOrigin, reviewModelLabel, savedRejudge } from "./rejudge.ts";
import { getSavedResult } from "./results.ts";
import { REJUDGE_PROMPT_VERSION, STAGE_PROMPT_VERSIONS } from "./prompts.ts";
import { sqlError, type JudgeSession } from "./session.ts";
import { currentSnapshotFromValues, type CurrentSnapshotReadOptions, type PersonalCandidateView, type PersonalSnapshotView } from "./snapshot.ts";
import { haversine, point } from "../filter/geography.ts";
import { sourcePoint } from "../filter/source-policy.ts";
import { MAX_REVIEW_CANDIDATES, MAX_SOURCE_ADS, buildManifest, buildManifestBatches } from "../filter/manifest.ts";
import type { PythonJson } from "../shared/python-json.ts";
import type { JudgeDatabaseHandle } from "./database.ts";
import { historySourceListingIds, readDashboardSourceSnapshot } from "./history-source.ts";
import { freshJudgeProfile, prepareCanonicalManifest, validateSelectedProfile, type JudgeProfileContext } from "./manifests.ts";
import { parseStoredJson, StoredJson, StoredJsonObject, type StoredStageResult } from "./stored.ts";

// Private facts collected by the accepted Source adapter, not another Source
// reader or a guessed public Source contract. No SQL runs against Source here.
export interface DashboardSourceFacts extends HistorySourceFacts {
  readonly ad: (NonNullable<HistorySourceFacts["ad"]> & {
    readonly title?: string;
    readonly employer?: string;
    readonly locations?: string;
    readonly detail_missing?: boolean;
    readonly application_due?: string | null;
  }) | null;
}

export interface DashboardSourceValues {
  readonly checked_at: string;
  readonly facts: ReadonlyMap<string, DashboardSourceFacts>;
}

const Metadata = Schema.Struct({
  title: Schema.String, employer: Schema.String, locations: Schema.Array(Schema.String),
  url: Schema.String, expires_at: Schema.optional(Schema.NullOr(Schema.String)), detail_missing: Schema.Boolean,
  reviewed_detail_changed: Schema.optional(StoredJson), reviewed_expiry_version: Schema.optional(StoredJson),
});

const HistoryView = Schema.Struct({
  result_id: Schema.String, listing_id: Schema.String, candidate: StoredJsonObject,
  provenance: Schema.Struct({ is_final_review: Schema.Boolean, assessed_at: Schema.NullOr(Schema.String) }),
});

const FallbackAd = Schema.Struct({ title: Schema.String, employer: Schema.String, locations: Schema.String, expires: Schema.NullOr(Schema.String), detail_missing: Schema.Boolean });
const Fit = Schema.Struct({ fit: Schema.String });

const fitOrder = new Map(["exceptional", "strong", "possible", "poor", "unknown"].map((fit, index) => [fit, index]));

type SavedResult = StoredStageResult | HistoricalResult;

interface SavedView { readonly result: SavedResult; readonly metadata: typeof Metadata.Type; readonly provenance: string; readonly context?: PythonJson }

const factsFor = (source: DashboardSourceValues, listingId: string) => {
  const facts = source.facts.get(listingId);

  return facts === undefined ? Either.left(new JudgeStateError({ message: "Historical Source facts are missing" })) : Either.right(facts);
};

const fallbackMetadata = (source: DashboardSourceValues, listingId: string, version: string) => Effect.gen(function* () {
  const facts = yield* factsFor(source, listingId);
  const matching = facts.ad !== null && facts.ad.changed === version;
  const ad = matching ? yield* Either.mapLeft(Schema.decodeUnknownEither(FallbackAd)(facts.ad), (cause) => new JudgeStateError({ message: "Historical Source display fields are missing", cause })) : null;

  return {
    title: ad?.title ?? "Historical title not recorded", employer: ad?.employer ?? "",
    locations: ad === null ? [] : yield* Either.mapLeft(Schema.decodeUnknownEither(Schema.Array(Schema.String))(yield* parseStoredJson(ad.locations)), (cause) => new JudgeStateError({ message: "Historical Source locations are invalid", cause })),
    url: `https://arbeidsplassen.nav.no/stillinger/stilling/${listingId}`,
    expires_at: ad?.expires ?? null, detail_missing: ad?.detail_missing ?? true,
  };
});

const savedViews = (session: JudgeSession, source: DashboardSourceValues) => Effect.gen(function* () {
  const saved = new Map<string, SavedView>();
  const history = yield* Effect.forEach(yield* historicalRows(session), (row) => Either.mapLeft(Schema.decodeUnknownEither(HistoryView)(row), (cause) => new JudgeStateError({ message: "Historical dashboard payload is invalid", cause })));

  history.sort((left, right) => Number(left.provenance.is_final_review) - Number(right.provenance.is_final_review) || left.result_id.localeCompare(right.result_id));

  for (const row of history) {
    const result = yield* historicalResult(session, row.result_id);

    if (result === null) continue;

    const metadata = yield* Either.mapLeft(Schema.decodeUnknownEither(Metadata)(row.candidate), (cause) => new JudgeStateError({ message: "Historical display metadata is invalid", cause }));
    const provenance = `Historical import; assessment time: ${row.provenance.assessed_at || "unknown"}; title screening, model and prompt not recorded`;
    saved.set(row.listing_id, { result, metadata, provenance });
  }

  const rows = yield* session.sql<{ result_id: string; listing_id: string; source_version: string }>`SELECT result_id,listing_id,source_version FROM stage_results WHERE stage='full_review' AND stage_version<>${REJUDGE_STAGE_VERSION} ORDER BY recorded_at,rowid`;

  for (const row of rows) {
    const result = yield* getSavedResult(session, row.result_id);

    if (result === null) return yield* new JudgeStateError({ message: "Saved full-review result is unavailable" });

    const prior = saved.get(row.listing_id);

    if (prior?.result.stage === "historical_full_review") {
      const provenance = yield* Either.mapLeft(Schema.decodeUnknownEither(Schema.Struct({ assessed_at: Schema.NullOr(Schema.String) }))(prior.result.provenance), (cause) => new JudgeStateError({ message: "Historical assessment time is invalid", cause }));

      if (provenance.assessed_at !== null && (yield* instant(result.recorded_at)) < (yield* instant(provenance.assessed_at))) continue;
    }

    const context = yield* savedResultContext(session, row.result_id);
    const metadata = context === null ? yield* fallbackMetadata(source, row.listing_id, row.source_version) : yield* Either.mapLeft(Schema.decodeUnknownEither(Metadata)(context), (cause) => new JudgeStateError({ message: "Saved dashboard metadata is invalid", cause }));
    const reused = Predicate.isRecord(context) && Object.hasOwn(context, "reused_from_result_id");
    saved.set(row.listing_id, { result, metadata, context, provenance: reused ? "Validated staged result; earlier assessment reused for matching ad text" : "Validated staged result; saved source binding" });
  }

  return saved;
});

const unverifiedBase = (profileId: string, checked: string): PersonalSnapshotView => ({
  profile_id: profileId, checked_at: checked, coverage_id: "", profile_fingerprint: "", preferences_fingerprint: "", rules_fingerprint: "", scoring_version: "",
  eligible_count: 0, review_terms: "", candidates: [], ranked: [], screened_out_count: 0, pending_count: 0, failed_count: 0, unknown_attempt_count: 0, closed: [], eligibility_verified: false,
});

const savedCandidate = (session: JudgeSession, base: PersonalSnapshotView, saved: SavedView, current: PersonalCandidateView | undefined, source: DashboardSourceValues, now: bigint, hasRepeat: boolean) => Effect.gen(function* () {
  const { result, metadata } = saved;
  const facts = yield* factsFor(source, result.listing_id);
  const same = current?.full_review_result_id === result.result_id;
  let provenance = saved.provenance;

  const origin = result.stage === "full_review" ? actualReviewContext(result, saved.context ?? null) : null;

  const older = same ? current.older_review || current.older_screening
    : Boolean(base.profile_fingerprint && origin !== null && (base.profile_fingerprint !== origin.review_profile
      || origin.review_prompt !== STAGE_PROMPT_VERSIONS.full_review
      || ("review_terms" in origin && origin.review_terms !== base.review_terms)));

  if (older) provenance += "; Made with an older profile or prompt";

  const full = yield* Either.mapLeft(Schema.decodeUnknownEither(StoredJsonObject)(result.value), (cause) => new JudgeStateError({ message: "Saved full-review value is invalid", cause }));

  const initial = hasRepeat && result.stage === "full_review" ? yield* initialReviewOrigin(session, result) : null;
  const repeat = initial === null ? null : yield* savedRejudge(session, initial);
  const repeatContext = repeat === null ? null : yield* savedResultContext(session, repeat.result_id);
  const binding = repeat === null ? metadata : yield* Either.mapLeft(Schema.decodeUnknownEither(Metadata)(repeatContext), (cause) => new JudgeStateError({ message: "Saved re-judge metadata is invalid", cause }));
  const expiry = binding.expires_at ?? null;
  let options: HistoryLifecycleOptions = { saved_version: repeat?.source_version ?? result.source_version, expires_at: expiry, now };

  if (binding.reviewed_detail_changed !== undefined) options = { ...options, reviewed_detail_changed: binding.reviewed_detail_changed };

  if (binding.reviewed_expiry_version !== undefined) options = { ...options, reviewed_expiry_version: binding.reviewed_expiry_version };

  const lifecycle = yield* sourceLifecycle(facts, options);
  let replacement = {};

  if (repeat !== null && initial !== null) {
    const first_fit = full["fit"];

    if (!Schema.is(FitLevel)(first_fit)) return yield* new JudgeStateError({ message: "First review fit is invalid" });
    const repeated = yield* Either.mapLeft(Schema.decodeUnknownEither(StoredJsonObject)(repeat.value), (cause) => new JudgeStateError({ message: "Saved re-judge value is invalid", cause }));

    const review = actualReviewContext(repeat, repeatContext);

    const older_review = Boolean(base.profile_fingerprint && (base.profile_fingerprint !== review.review_profile
      || review.review_prompt !== REJUDGE_PROMPT_VERSION
      || ("review_terms" in review && review.review_terms !== base.review_terms)));

    replacement = {
      full_review: repeated, full_review_result_id: repeat.result_id, full_review_input_fingerprint: repeat.input_fingerprint,
      review_prompt_version: repeat.prompt_version, older_review,
      rejudge: { first_fit, first_model: yield* reviewModelLabel(session, initial), model: yield* reviewModelLabel(session, repeat), reviewed_at: repeat.recorded_at },
    } satisfies Partial<PersonalCandidateView>;
  }

  return {
    listing_id: result.listing_id, source_version: result.source_version, title: metadata.title, employer: metadata.employer,
    locations: metadata.locations, url: metadata.url,
    expires_at: repeat === null || lifecycle.expires_at === undefined ? expiry : lifecycle.expires_at,
    detail_missing: metadata.detail_missing,
    screening_status: same ? current.screening_status : "not_recorded_for_this_result", screening: same ? current.screening : null,
    screening_attempt_status: same ? current.screening_attempt_status : "not_recorded", full_review_status: "completed", full_review: full,
    older_screening: same && current.older_screening, older_review: older, rereview_pending: current?.rereview_pending ?? false,
    full_review_result_id: result.result_id, full_review_input_fingerprint: result.input_fingerprint, review_prompt_version: result.prompt_version,
    scoring_version: result.scoring_version, profile_fingerprint: result.profile_fingerprint, preferences_fingerprint: result.preferences_fingerprint, rules_fingerprint: result.rules_fingerprint,
    full_review_attempt_status: provenance.startsWith("Validated") ? "completed" : "historical_import", recommendable: false,
    lifecycle_status: lifecycle.lifecycle_status, provenance,
    application_due: lifecycle.application_due === undefined ? facts.ad?.application_due ?? null : lifecycle.application_due,
    full_review_blocked_sub_reason: null,
    ...replacement,
  } satisfies PersonalCandidateView;
});

export type RunPoolFacts = Omit<typeof RunPool.Type, "listed_review_ids"> & {
  readonly reviewResults: ReadonlyMap<string, string>;
};

type DashboardSnapshot = PersonalSnapshotView & { readonly runPool: RunPoolFacts | null };

const runPoolFacts = (
  session: JudgeSession, base: PersonalSnapshotView & { readonly runFilters?: typeof RunFilters.Type },
  finalReviews: ReadonlyMap<string, PersonalCandidateView> = new Map(), repeated: ReadonlySet<string> = new Set(),
): Effect.Effect<RunPoolFacts | null, JudgeStateError> => Effect.gen(function* () {
  if (base.runFilters === undefined) return null;
  const screen = { out: 0, undecided: 0, advanced: 0 };
  const judge = { unfinished: 0, fits: { exceptional: 0, strong: 0, possible: 0, unknown: 0, poor: 0 } };
  const reviewResults = new Map<string, string>();
  let waiting = 0;
  let failed = 0;

  for (const candidate of [...base.candidates, ...base.closed]) {
    if (candidate.screening_status === "screened_out") {
      screen.out++;
      continue;
    }

    const advanced = candidate.screening_status === "advance_to_full_review";

    if (advanced) {
      screen.advanced++;
      const firstId = candidate.full_review_result_id;

      if (firstId !== null) {
        const displayed = finalReviews.get(firstId);
        let fit = (displayed ?? candidate).full_review?.["fit"];
        let resultId = displayed?.full_review_result_id ?? firstId;

        // The history winner can differ from the current candidate’s review.
        if (!displayed && repeated.has(candidate.listing_id)) {
          const first = yield* getSavedResult(session, firstId);

          if (first?.stage !== "full_review") return yield* new JudgeStateError({ message: "Current full-review result is unavailable" });
          const repeat = yield* savedRejudge(session, yield* initialReviewOrigin(session, first));

          if (repeat !== null) {
            fit = Predicate.isRecord(repeat.value) ? repeat.value["fit"] : undefined;
            resultId = repeat.result_id;
          }
        }

        if (!Schema.is(FitLevel)(fit)) return yield* new JudgeStateError({ message: "Current full-review fit is invalid" });
        judge.fits[fit]++;
        reviewResults.set(candidate.listing_id, resultId);
        continue;
      }

      judge.unfinished++;
    } else screen.undecided++;

    const status = advanced ? candidate.full_review_attempt_status : candidate.screening_attempt_status;

    if (status === "pending") waiting++;
    else if (status === "failed" || status === "blocked") failed++;
  }

  return { filters: base.runFilters, screen, judge, waiting, failed, reviewResults };
});

// The owning wrapper supplies its real current-snapshot effect. Failure leaves
// eligibility unknown; a historical read never grants submission permission.
export const dashboardSnapshotFromValues = <R>(session: JudgeSession, current: Effect.Effect<PersonalSnapshotView & { readonly runFilters?: typeof RunFilters.Type }, JudgeStateError, R>, source: DashboardSourceValues, now: bigint): Effect.Effect<DashboardSnapshot, JudgeStateError, R> => Effect.gen(function* () {
  const checked = yield* isoInstant(source.checked_at);
  const outcome = yield* Effect.either(current);
  const base = Either.isRight(outcome) ? outcome.right : unverifiedBase(session.profile_id, checked);

  if (!session.initialized) return { ...base, runPool: yield* runPoolFacts(session, base) };

  const saved = yield* savedViews(session, source);
  const fresh = new Map(base.candidates.map((candidate) => [candidate.listing_id, candidate]));
  const visibleSaved = [...saved.values()].filter((row) => fresh.get(row.result.listing_id)?.screening_status !== "screened_out");
  const repeated = new Set((yield* session.sql<{ listing_id: string }>`SELECT DISTINCT listing_id FROM stage_results WHERE stage_version=${REJUDGE_STAGE_VERSION}`).map((row) => row.listing_id));
  const candidates = yield* Effect.forEach(visibleSaved, (row) => savedCandidate(session, base, row, fresh.get(row.result.listing_id), source, now, repeated.has(row.result.listing_id)));
  // A repeat belongs to its original review, not just to the same listing.
  const finalReviews = new Map(visibleSaved.map((row, index) => [row.result.result_id, candidates[index]!]));

  const ordered = yield* Effect.forEach(candidates, (candidate) => Effect.gen(function* () {
    const fit = yield* Either.mapLeft(Schema.decodeUnknownEither(Fit)(candidate.full_review), (cause) => new JudgeStateError({ message: "Saved full-review fit is missing", cause }));

    return { candidate, order: fitOrder.get(fit.fit) ?? 4 };
  }));

  ordered.sort((left, right) => left.order - right.order || left.candidate.listing_id.localeCompare(right.candidate.listing_id));

  const closedStatuses = new Set(["application_deadline_passed", "source_expired", "confirmed_closed"]);
  const visible = ordered.filter((row) => !closedStatuses.has(row.candidate.lifecycle_status)).map((row) => row.candidate);
  const closed = ordered.filter((row) => closedStatuses.has(row.candidate.lifecycle_status)).map((row) => row.candidate);
  const pending = base.candidates.filter((candidate) => !saved.has(candidate.listing_id));

  return { ...base, checked_at: checked, candidates: [...visible, ...pending], ranked: visible.filter((candidate) => candidate.lifecycle_status !== "expiry_unverified"), closed, runPool: yield* runPoolFacts(session, base, finalReviews, repeated) };
}).pipe(Effect.mapError(sqlError));

export const readDashboardSnapshot = (store: JudgeDatabaseHandle, context: JudgeProfileContext, now: bigint, options: CurrentSnapshotReadOptions = {}) => Effect.gen(function* () {
  yield* validateSelectedProfile(store, context.profile);
  const profile = yield* Effect.either(freshJudgeProfile(context));
  const source = yield* readDashboardSourceSnapshot(context.profile.paths.source_db, yield* historySourceListingIds(store), MAX_SOURCE_ADS, yield* isoInstant(now));

  const current = Effect.gen(function* () {
    const selected = yield* profile;
    const snapshot = yield* Either.mapLeft(source.current, (cause) => new JudgeStateError({ message: "Cannot read selected Source for current manifest", cause }));
    const prepared = yield* prepareCanonicalManifest(selected, snapshot, now);
    const limit = options.limit ?? MAX_REVIEW_CANDIDATES;
    const batches = yield* buildManifestBatches(prepared.common, prepared.candidates, prepared.checked_at, { limit });
    const first = batches[0] ?? (yield* buildManifest(prepared.common, prepared.candidates, prepared.checked_at, { limit }));

    const view = yield* currentSnapshotFromValues(store, { manifest: first, candidates: batches.flatMap((batch) => batch.candidates), eligible_count: first.eligible_count }, now, options);

    return { ...view, runFilters: prepared.filters };
  }).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));

  const view = yield* dashboardSnapshotFromValues(store, current, source.history, now);
  // Display only: require evidence for the saved listing version, not a municipality bound.
  const distances = new Map<string, number>();

  if (Either.isRight(profile) && Either.isRight(source.current)) {
    const prefs = profile.right.settings.preferences;
    const origin = prefs.origin_source ? point(prefs.origin_latitude, prefs.origin_longitude) : null;
    const { ads, location_points, location_binding_digests } = source.current.right;
    const versions = new Map(ads.map((ad) => [ad.uuid, ad.changed]));

    if (origin !== null) {
      for (const job of [...view.ranked, ...view.closed]) {
        if (versions.get(job.listing_id) !== job.source_version || !Object.hasOwn(location_binding_digests, job.listing_id)) continue;

        const points = location_points[job.listing_id]?.[0] ?? [];

        const nearest = points.reduce<number>((distance, raw) => {
          const target = sourcePoint(raw);

          return target === null ? distance : Math.min(distance, haversine(origin, target));
        }, Infinity);

        if (Number.isFinite(nearest)) distances.set(job.listing_id, nearest);
      }
    }
  }

  return { ...view, distances };
});
