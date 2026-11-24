import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { resolve } from "node:path";
import { SnapshotAssessment } from "../../contracts/snapshot.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { GeographyAreas } from "../filter/geography-service.ts";
import { FilterResources } from "../filter/service.ts";
import { readDashboardSnapshot } from "../judge/dashboard.ts";
import { openJudgeDatabase } from "../judge/database.ts";
import type { PersonalCandidateView } from "../judge/snapshot.ts";
import { readFullReviewFirstFound } from "../judge/views.ts";
import { Market } from "../market/service.ts";
import { Profile } from "../profile/service.ts";
import { SnapshotError } from "./errors.ts";
import { prepareSnapshotMarketInputs, readSnapshotMarketInputs } from "./market-inputs.ts";
import { SnapshotFacts } from "./service.ts";

const projectCandidate = (candidate: PersonalCandidateView) => Effect.gen(function* () {
  const review = candidate.full_review;

  const full_review = review === null ? null : yield* Schema.decodeUnknown(Schema.typeSchema(SnapshotAssessment), { onExcessProperty: "error" })({
    fit: review["fit"], reason: review["reason"], evidence: review["evidence"], uncertainties: review["uncertainties"],
    hard_constraints: review["hard_constraints"], ad_text_reviewed: review["ad_text_reviewed"],
  });

  const projected = {
    listing_id: candidate.listing_id, source_version: candidate.source_version,
    title: candidate.title, employer: candidate.employer, locations: candidate.locations,
    url: candidate.url, application_due: candidate.application_due, expires_at: candidate.expires_at,
    lifecycle_status: candidate.lifecycle_status, full_review_result_id: candidate.full_review_result_id, full_review,
    older_review: candidate.older_review,
  };

  return candidate.rejudge === undefined ? projected : { ...projected, rejudge: candidate.rejudge };
});

// Capture the caller's canonical services. Do not replace them with fresh default
// Profile/Source layers, and never clone the private Judge SQL in this adapter.
export const SnapshotFactsLive = Layer.effect(SnapshotFacts, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const profileService = yield* Profile;
  const geography = yield* GeographyAreas;
  const resources = yield* FilterResources;
  const market = yield* Market;

  return SnapshotFacts.of({ load: (profile, now, frozenPath, admitFrozenMarket) => Effect.scoped(Effect.gen(function* () {
    const parsed = parseIsoTime(now);

    if (Option.isNone(parsed) || !parsed.value.aware) return yield* new SnapshotError({ message: "Snapshot time must include a timezone" });
    const root = resolve(profile.paths.directory, "../../..");

    const readMarket = admitFrozenMarket === undefined ? readSnapshotMarketInputs(profile, now, frozenPath)
      : yield* prepareSnapshotMarketInputs(profile, now, frozenPath, admitFrozenMarket);

    const store = yield* openJudgeDatabase({ profile_id: profile.profile_id, directory: profile.paths.directory, path: profile.paths.review_db, readonly: true, require_existing: false });

    const saved = yield* store.sql.readSnapshot(Effect.gen(function* () {
      const found = yield* readFullReviewFirstFound(store);
      const dashboard = yield* readDashboardSnapshot(store, { root, profile }, parsed.value.epochMicros);
      const ranked = yield* Effect.forEach(dashboard.ranked, projectCandidate);
      const closed = yield* Effect.forEach(dashboard.closed, projectCandidate);

      return { found, dashboard, ranked, closed };
    }));

    const facts = yield* readMarket;

    return {
      now, profile: { id: profile.profile_id, mode: profile.policy.mode },
      funnel: { verified: true, listingIds: new Set(saved.found.map((row) => row.listing_id)) },
      judge: {
        checked_at: saved.dashboard.checked_at, eligible_count: saved.dashboard.eligible_count,
        pending_count: saved.dashboard.pending_count, screened_out_count: saved.dashboard.screened_out_count,
        failed_count: saved.dashboard.failed_count, ranked: saved.ranked, closed: saved.closed,
        runPool: saved.dashboard.runPool, distances: saved.dashboard.distances,
        firstFound: Object.fromEntries(saved.found.map((row) => [row.listing_id, row.first_found_at])),
      },
      market: facts,
    };
  })).pipe(
    Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Profile, profileService),
    Effect.provideService(GeographyAreas, geography), Effect.provideService(FilterResources, resources),
    Effect.provideService(Market, market),
    Effect.mapError(() => new SnapshotError({ message: "Cannot read saved snapshot inputs" })),
  ) });
}));
