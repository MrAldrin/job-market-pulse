import { Effect } from "effect";
import type { ProfileBundle } from "../../contracts/profile.ts";
import type { ManifestSourceSnapshot } from "../../contracts/source-readers.ts";
import { loadTitleEvidence } from "../filter/evidence-pack.ts";
import type { TitleEvidence } from "../filter/title-evidence.ts";
import { GeographyAreas } from "../filter/geography-service.ts";
import { buildManifest, buildManifestBatches, manifestCommon, MAX_REVIEW_CANDIDATES, MAX_SOURCE_ADS, sourceFreshness, type ManifestOptions } from "../filter/manifest.ts";
import { prepareCandidates, FilterResources } from "../filter/service.ts";
import { Profile, type PersonalInputs } from "../profile/service.ts";
import { readManifest } from "../source/readers.ts";
import type { JudgeDatabaseHandle } from "./database.ts";
import { isoInstant } from "./core.ts";
import { JudgeStateError } from "./errors.ts";

export interface JudgeProfileContext {
  readonly root: string;
  readonly profile: ProfileBundle;
}

export const validateSelectedProfile = (store: Pick<JudgeDatabaseHandle, "profile_id" | "path">, profile: ProfileBundle) =>
  profile.profile_id === store.profile_id && profile.paths.review_db === store.path
    ? Effect.void
    : Effect.fail(new JudgeStateError({ message: "Profile does not match personal state store" }));

export interface PersonalProfile {
  readonly bundle: ProfileBundle;
  readonly settings: PersonalInputs;
  readonly evidence: TitleEvidence;
}

export const freshJudgeProfile = (context: JudgeProfileContext) => Effect.gen(function* () {
  const settings = yield* (yield* Profile).readPersonalInputs(context.root, context.profile);

  const evidence = yield* loadTitleEvidence(context.root);

  return { bundle: context.profile, settings, evidence } satisfies PersonalProfile;
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));

export const profileMaxAge = (profile: ProfileBundle): bigint => BigInt(Math.round(profile.policy.freshness_max_age.$seconds * 1_000_000));

// Source owns SQL, decoding and its single read snapshot. This adapter supplies
// only its checked/caught-up facts to the real Filter policy and constructors.
export const prepareCanonicalManifest = (profile: PersonalProfile, source: ManifestSourceSnapshot, now: bigint) => Effect.gen(function* () {
  const common = yield* manifestCommon(profile.bundle.profile_id, profile.settings, undefined, profile.evidence);
  const checkedAt = source.state["checked"];

  if (checkedAt === undefined) return yield* new JudgeStateError({ message: "Saved source check is missing" });

  const maxAge = profileMaxAge(profile.bundle);
  yield* sourceFreshness(checkedAt, source.state["caught_up"] ?? "", now, maxAge);
  const resources = yield* FilterResources;
  const areas = yield* (yield* GeographyAreas).load(resources.areaExtentsPath);
  const snapshot = { ...source, checked_at: checkedAt, caught_up: source.state["caught_up"] ?? "" };
  const prepared = yield* prepareCandidates(snapshot, profile.settings, areas, now, undefined, profile.evidence);

  return { ...prepared, common, checked_at: checkedAt, max_age_micros: maxAge };
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));

export const readCanonicalManifest = (profile: PersonalProfile, now: bigint, options: ManifestOptions = {}) => Effect.gen(function* () {
  const source = yield* readManifest(profile.bundle.paths.source_db, MAX_SOURCE_ADS, yield* isoInstant(now));
  const prepared = yield* prepareCanonicalManifest(profile, source, now);

  return yield* buildManifest(prepared.common, prepared.candidates, prepared.checked_at, options);
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));

export const currentManifests = (store: Pick<JudgeDatabaseHandle, "profile_id" | "path">, context: JudgeProfileContext, now: bigint, limit = MAX_REVIEW_CANDIDATES) => Effect.gen(function* () {
  yield* validateSelectedProfile(store, context.profile);
  const profile = yield* freshJudgeProfile(context);
  const source = yield* readManifest(profile.bundle.paths.source_db, MAX_SOURCE_ADS, yield* isoInstant(now));
  const prepared = yield* prepareCanonicalManifest(profile, source, now);
  const batches = yield* buildManifestBatches(prepared.common, prepared.candidates, prepared.checked_at, { limit });
  const first = batches[0] ?? (yield* buildManifest(prepared.common, prepared.candidates, prepared.checked_at, { limit }));

  return { first, batches };
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));
