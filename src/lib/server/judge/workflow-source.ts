import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Candidate, CandidateManifest } from "../../contracts/filter.ts";
import type { SourceRefreshSummary } from "../../contracts/source.ts";
import type { AdTextBatch } from "../../contracts/source-review.ts";
import * as currentAdmission from "../filter/current-admission.ts";
import { loadTitleEvidence } from "../filter/evidence-pack.ts";
import { GeographyAreas } from "../filter/geography-service.ts";
import { FilterResources } from "../filter/service.ts";
import * as sourcePolicy from "../filter/source-policy.ts";
import { Profile } from "../profile/service.ts";
import { SourceError } from "../source/errors.ts";
import { NavClient } from "../source/nav-client.ts";
import { fetchCurrentAdTexts } from "../source/review-text.ts";
import { Source } from "../source/service.ts";
import { JsonInput, JsonObject } from "../shared/json-input.ts";
import { isoInstant } from "./core.ts";
import { freshJudgeProfile, type JudgeProfileContext } from "./manifests.ts";
import { WorkflowError } from "./workflow-errors.ts";

export class ReviewSource extends Context.Tag("pulse/ReviewSource")<ReviewSource, {
  readonly checkFresh: (context: JudgeProfileContext, now: bigint) => Effect.Effect<readonly [boolean, string | null], WorkflowError>;
  readonly refresh: (context: JudgeProfileContext) => Effect.Effect<SourceRefreshSummary, WorkflowError>;
  readonly fetchTexts: (context: JudgeProfileContext, manifest: CandidateManifest, candidates: readonly Candidate[]) => Effect.Effect<AdTextBatch, WorkflowError>;
}>() {}

const failure = (cause: unknown) => new WorkflowError({ code: cause instanceof SourceError ? (cause.transient ? "source_temporary" : cause.code ?? "source_refresh_failed") : "source_profile_invalid" });

// Capture services only; no profile, store or network access during layer construction.
export const ReviewSourceLive = Layer.effect(ReviewSource, Effect.gen(function* () {
  const source = yield* Source;
  const profile = yield* Profile;
  const geography = yield* GeographyAreas;
  const resources = yield* FilterResources;
  const fs = yield* FileSystem.FileSystem;
  const nav = yield* NavClient;
  const areas = () => geography.load(resources.areaExtentsPath);

  return {
    checkFresh: (context, now) => Effect.gen(function* () {
      const instant = yield* isoInstant(now);

      return yield* source.checkFresh(context.profile.paths.source_db, instant, context.profile.policy.freshness_max_age.$seconds * 1000);
    }).pipe(Effect.mapError(failure)),
    refresh: (context) => Effect.gen(function* () {
      const loaded = yield* profile.load(context.root, context.profile.profile_id);

      // The selected model settings can override this session's batch size only.
      const selected = { ...context.profile, full_review_batch_size: loaded.bundle.full_review_batch_size };

      if (!isDeepStrictEqual(loaded.bundle, selected)) return yield* new WorkflowError({ code: "source_profile_invalid" });
      const evidence = yield* loadTitleEvidence(context.root).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const policy = yield* sourcePolicy.makeSourcePolicy(loaded.settings, yield* areas(), undefined, evidence);

      return yield* source.refreshPersonal(context.profile.paths.source_db, join(context.profile.paths.directory, "location-resolution.json"), policy);
    }).pipe(Effect.mapError((error) => error instanceof WorkflowError ? error : failure(error))),
    fetchTexts: (context, manifest, candidates) => Effect.scoped(Effect.gen(function* () {
      const selected = yield* freshJudgeProfile(context).pipe(Effect.provideService(Profile, profile));
      const admissionCheck = currentAdmission.makeCurrentAdmission(selected.settings, manifest, yield* areas());

      if (!Schema.is(JsonObject)(manifest) || !Schema.is(Schema.Array(JsonInput))(candidates)) return yield* new WorkflowError({ code: "source_manifest_invalid" });

      return yield* fetchCurrentAdTexts({ databasePath: context.profile.paths.source_db, manifest, candidates, admissionCheck });
    })).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(NavClient, nav), Effect.mapError((error) => error instanceof WorkflowError ? error : failure(error))),
  };
}));
