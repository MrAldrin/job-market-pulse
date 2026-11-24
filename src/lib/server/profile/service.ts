import { Context, Effect, Either, Layer, Predicate, Schema } from "effect";
import { join } from "node:path";
import type { FiltersSettings, JudgeSettings, Preferences, ScreenSettings } from "../../contracts/profile-settings.ts";
import { type Cadence, PROFILE_TEXT_MAX_BYTES, ProfileBundle, ProfileStatus, type ProfilePaths } from "../../contracts/profile.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { sha256 } from "../shared/python-json.ts";
import { strip } from "../shared/text.ts";
import { bundleFor, dateToken, decodeProfileId, decodeProfileSettings, parseCadence, pathsFor, profileStatus, replaceModeText } from "./core.ts";
import { ProfileError } from "./errors.ts";
import { ProfileFiles } from "./files.ts";
import { hasMeaningfulContent } from "./narrative.ts";
import { validateSchedule } from "./schedule-period.ts";
import { decodeFilters, decodeJudge, decodeScreen, screenVersion, mergePreferences, preferenceVersion } from "./settings.ts";

export interface OwnedSettings {
  readonly filters: FiltersSettings;
  readonly judge: JudgeSettings;
  readonly screen: ScreenSettings;
  readonly preferences: Preferences;
  readonly preference_fingerprint: string;
  readonly profile_fingerprint: string;
  readonly rules_fingerprint: string;
}

export type PersonalInputs = Pick<OwnedSettings, "filters" | "judge" | "preferences" | "preference_fingerprint" | "profile_fingerprint">;

type PersonalPreferences = Omit<PersonalInputs, "profile_fingerprint">;

const personalPreferences = (filters: FiltersSettings, judge: JudgeSettings): Either.Either<PersonalPreferences, ProfileError> =>
  Either.map(mergePreferences(filters, judge), (preferences) => ({
    filters, judge, preferences,
    preference_fingerprint: preferenceVersion(preferences, filters.geography?.radius_km ?? preferences.radius_km),
  }));

const bindNarrative = (preferences: PersonalPreferences, narrative: string): PersonalInputs => ({ ...preferences, profile_fingerprint: sha256(narrative) });

export interface LoadedProfile {
  readonly bundle: ProfileBundle;
  readonly settings: OwnedSettings;
  readonly narrative: string;
  readonly schedule: { readonly expression: string; readonly anchor: string | null };
}

export class Profile extends Context.Tag("pulse/Profile")<Profile, {
  readonly load: (root: string, id: string) => Effect.Effect<LoadedProfile, ProfileError>;
  readonly readPersonalInputs: (root: string, selected: ProfileBundle) => Effect.Effect<PersonalInputs, ProfileError>;
  readonly inspect: (root: string, id: string) => Effect.Effect<ProfileStatus, ProfileError>;
  readonly cadence: (root: string, id: string) => Effect.Effect<Cadence, ProfileError>;
  readonly setMode: (root: string, id: string, mode: string) => Effect.Effect<void, ProfileError>;
}>() {}

export const ProfileLive = Layer.effect(Profile, Effect.gen(function* () {
  const files = yield* ProfileFiles;

  const readPreferenceFiles = (root: string, paths: ProfilePaths) => Effect.gen(function* () {
    const filters = yield* files.read(root, join(paths.directory, "filters.toml")).pipe(Effect.flatMap(decodeFilters));
    const judge = yield* files.read(root, join(paths.directory, "judge.toml")).pipe(Effect.flatMap(decodeJudge));

    return { filters, judge };
  });

  const parse = (rawRoot: string, id: string) => Effect.gen(function* () {
    yield* decodeProfileId(id);
    const root = yield* files.root(rawRoot);
    const directory = join(root, "local_only", "profiles", id);
    yield* files.check(root, directory, "Directory");
    const config = yield* files.read(root, join(directory, "profile.toml")).pipe(Effect.flatMap(decodeProfileSettings));

    if (config.profile.id !== id) return yield* new ProfileError({ message: "Profile ID does not match its directory" });

    const paths = yield* pathsFor(root, id, config);
    const cadence = yield* parseCadence(config.policy);

    const fallback = cadence.kind === "weekly" ? "weekly" : "every 2 weeks";
    const savedSchedule = config.schedule;
    const savedAnchor = savedSchedule?.anchor === undefined ? undefined : dateToken(savedSchedule.anchor);

    if (savedSchedule !== undefined) {
      yield* validateSchedule(savedAnchor === undefined ? savedSchedule : { ...savedSchedule, anchor: savedAnchor }, fallback).pipe(
        Effect.mapError(() => new ProfileError({ message: "Invalid profile schedule" })),
      );
    }

    const schedule = { expression: savedSchedule?.schedule ?? fallback, anchor: savedAnchor ?? cadence.anchor };

    const bundle = yield* decodeStrict(ProfileBundle)(bundleFor(id, paths, config, cadence)).pipe(
      Effect.mapError(() => new ProfileError({ message: "Invalid profile bundle" })),
    );

    // Guard every active resource before contents; the legacy preferences path is metadata only.
    for (const path of [paths.narrative_file, paths.review_db, paths.ledger_db, ...["filters.toml", "screen.toml", "judge.toml"].map((name) => join(directory, name))]) {
      yield* files.check(root, path, "File");
    }

    const outbox = yield* files.check(root, paths.outbox_dir, "Directory");
    const source = yield* files.check(root, paths.source_db, "File");
    let reason: string | null = source ? null : "shared source database is missing";
    let inputs: Pick<LoadedProfile, "settings" | "narrative"> | null = null;

    if (reason === null) {
      const loaded = yield* Effect.either(Effect.gen(function* () {
        const { filters, judge } = yield* readPreferenceFiles(root, paths);
        const screenText = yield* files.read(root, join(directory, "screen.toml"));
        const screen = yield* decodeScreen(screenText);
        const personal = yield* personalPreferences(filters, judge);

        const configured = Object.values(filters.geography ?? {}).some((value) =>
          Predicate.isString(value) ? strip(value).length > 0
            : Schema.is(Schema.Array(Schema.String))(value) ? value.length > 0 : value !== undefined,
        )
          || Object.values(filters.jobs ?? {}).some((values) => (values?.length ?? 0) > 0)
          || (judge.jobs?.preferred_terms?.length ?? 0) > 0;

        if (!configured) return yield* new ProfileError({ message: "private preferences are still a placeholder" });

        const narrative = yield* files.read(root, paths.narrative_file, PROFILE_TEXT_MAX_BYTES);

        if (!hasMeaningfulContent(narrative)) return yield* new ProfileError({ message: "private narrative profile is still a placeholder" });

        return { settings: { ...bindNarrative(personal, narrative), screen, rules_fingerprint: screenVersion(screen) }, narrative };
      }));

      if (Either.isLeft(loaded)) reason = loaded.left.message;
      else inputs = loaded.right;
    }

    if (reason === null && !outbox) reason = "profile outbox directory is missing";

    return { bundle, inputs, schedule, reason };
  });

  return {
    readPersonalInputs: (rawRoot: string, selected: ProfileBundle) => Effect.gen(function* () {
      const root = yield* files.root(rawRoot);
      const { filters, judge } = yield* readPreferenceFiles(root, selected.paths);
      const personal = yield* personalPreferences(filters, judge);
      const narrative = yield* files.read(root, selected.paths.narrative_file, PROFILE_TEXT_MAX_BYTES);

      if (/^[\t\n\v\f\r ]*$/.test(narrative)) return yield* new ProfileError({ message: "Profile must be nonempty and at most 100 KB" });

      return bindNarrative(personal, narrative);
    }),
    load: (root: string, id: string) => parse(root, id).pipe(Effect.flatMap(({ bundle, inputs, schedule, reason }) =>
      reason !== null || inputs === null
        ? Effect.fail(new ProfileError({ message: `Profile is not ready: ${reason ?? "private settings are missing"}` }))
        : Effect.succeed({ bundle, ...inputs, schedule }),
    )),
    cadence: (root: string, id: string) => parse(root, id).pipe(Effect.map(({ bundle }) => bundle.policy.cadence)),
    setMode: (root: string, id: string, mode: string) => Effect.gen(function* () {
      const { bundle } = yield* parse(root, id);
      const canonicalRoot = yield* files.root(root);
      const text = yield* files.read(canonicalRoot, bundle.paths.profile_file);
      const updated = yield* replaceModeText(text, mode);
      yield* files.replace(canonicalRoot, bundle.paths.profile_file, updated);
    }),
    inspect: (root: string, id: string) => parse(root, id).pipe(Effect.flatMap(({ bundle, reason }) =>
      Schema.decodeUnknown(ProfileStatus, { onExcessProperty: "error" })(profileStatus(bundle, reason)).pipe(
        Effect.mapError(() => new ProfileError({ message: "Invalid profile status" })),
      ),
    )),
  };
}));
