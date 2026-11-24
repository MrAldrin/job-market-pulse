import { Context, Effect, Either, Layer, Schema } from "effect";
import type { TomlTable } from "smol-toml";
import { join, resolve } from "node:path";
import { FiltersSettings, JudgeSettings } from "../../contracts/profile-settings.ts";
import { decodeStrict, nonemptyText } from "../../contracts/support.ts";
import { collapseWhitespace, strip } from "../shared/text.ts";
import { parseToml, writeToml } from "../shared/toml.ts";
import { decodeProfileId, decodeProfileSettings, pathsFor } from "./core.ts";
import { ProfileError } from "./errors.ts";
import { ProfileFiles } from "./files.ts";
import { decodeFilters, decodeJudge, decodeScreen, mergePreferences, uniqueStrings } from "./settings.ts";

// This is the only reader of legacy preference/base files. It is not in ProfileLive.
const LegacySettings = Schema.Struct({
  geography: FiltersSettings.fields.geography,
  jobs: Schema.optional(Schema.Struct({
    preferred_terms: Schema.optional(Schema.Array(nonemptyText)), excluded_title_terms: Schema.optional(Schema.Array(nonemptyText)),
    excluded_employers: Schema.optional(Schema.Array(nonemptyText)), allowed_occupation_categories: Schema.optional(Schema.Array(nonemptyText)),
  })),
});

const decodeLegacy = (text: string) => Either.flatMap(parseToml(text), (raw) =>
  Either.mapLeft(decodeStrict(LegacySettings)(raw), () => new ProfileError({ message: "Invalid legacy settings" })),
);

export interface SplitSettingsText {
  readonly filters: string;
  readonly judge: string;
  readonly screen: string;
}

export const splitSettingsText = (preferences: string, titleRules: string, base = ""): Either.Either<SplitSettingsText, ProfileError> => Either.gen(function* () {
  const local = yield* decodeLegacy(preferences);
  const defaults = yield* decodeLegacy(base);
  const geography = { ...defaults.geography, ...local.geography };

  // Python casts explicitly local radius to float, but preserves an inherited base integer.
  if (local.geography?.radius_km !== undefined) geography.radius_km = Number(local.geography.radius_km);

  if (geography.home_postcode !== undefined) geography.home_postcode = strip(geography.home_postcode);

  if (geography.home_label !== undefined) geography.home_label = collapseWhitespace(geography.home_label);

  if (geography.origin_source !== undefined) geography.origin_source = strip(geography.origin_source);

  for (const key of ["preferred_municipalities", "nearby_municipalities", "excluded_municipalities"] as const) {
    if (geography[key] !== undefined) geography[key] = uniqueStrings(geography[key]);
  }

  const jobs = { ...defaults.jobs, ...local.jobs };

  for (const key of ["preferred_terms", "excluded_title_terms", "excluded_employers", "allowed_occupation_categories"] as const) {
    if (jobs[key] !== undefined) jobs[key] = uniqueStrings(jobs[key]);
  }

  const { preferred_terms, ...filterJobs } = jobs;
  const filters = { geography, jobs: filterJobs };
  const judge: JudgeSettings = preferred_terms === undefined ? {} : { jobs: { preferred_terms } };
  yield* decodeScreen(titleRules);
  yield* mergePreferences(filters, judge);
  const geographyTable: TomlTable = {};
  const stringArray = Schema.is(Schema.Array(Schema.String));

  for (const [key, value] of Object.entries(geography)) {
    if (value !== undefined) geographyTable[key] = stringArray(value) ? Array.from(value) : value;
  }

  const jobsTable: TomlTable = {};

  for (const [key, value] of Object.entries(filterJobs)) {
    if (value !== undefined) jobsTable[key] = Array.from(value);
  }

  const filtersText = yield* writeToml({ geography: geographyTable, jobs: jobsTable });
  const judgeText = yield* writeToml(preferred_terms === undefined ? {} : { jobs: { preferred_terms: Array.from(preferred_terms) } });
  yield* decodeFilters(filtersText);
  yield* decodeJudge(judgeText);

  // Preserve title-rule byte identity, including comments/version text. No reformatting.
  return { filters: filtersText, judge: judgeText, screen: titleRules };
});

export interface SplitSettingsRequest {
  readonly root: string;
  readonly profileId: string;
  readonly titleRules: string;
  readonly defaults?: string;
}

export class SettingsConverter extends Context.Tag("pulse/SettingsConverter")<SettingsConverter, {
  readonly split: (request: SplitSettingsRequest) => Effect.Effect<readonly string[], ProfileError>;
}>() {}

export const SettingsConverterLive = Layer.effect(SettingsConverter, Effect.gen(function* () {
  const files = yield* ProfileFiles;

  return {
    split: (request: SplitSettingsRequest) => Effect.gen(function* () {
      yield* decodeProfileId(request.profileId);
      const root = yield* files.root(request.root);
      const directory = join(root, "local_only", "profiles", request.profileId);
      const config = yield* files.read(root, join(directory, "profile.toml")).pipe(Effect.flatMap(decodeProfileSettings));

      if (config.profile.id !== request.profileId) return yield* new ProfileError({ message: "Profile ID does not match its directory" });

      const paths = yield* pathsFor(root, request.profileId, config);
      const targets = ["filters.toml", "screen.toml", "judge.toml"].map((name) => join(directory, name));

      for (const target of targets) {
        if (yield* files.check(root, target, "File")) return yield* new ProfileError({ message: "Split settings already exist; nothing was written" });
      }

      const preferences = yield* files.read(root, paths.preferences_file);
      const rules = yield* files.read(root, resolve(root, request.titleRules));
      const base = request.defaults === undefined ? "" : yield* files.read(root, resolve(root, request.defaults));
      const converted = yield* splitSettingsText(preferences, rules, base);
      const contents = [converted.filters, converted.screen, converted.judge];
      const created: string[] = [];
      yield* Effect.forEach(targets, (target, index) => files.create(root, target, contents[index] ?? "").pipe(
        Effect.tap(() => Effect.sync(() => { created.push(target); })),
      ), { concurrency: 1, discard: true }).pipe(Effect.onError(() =>
        Effect.forEach(created.toReversed(), (path) => files.remove(root, path), { discard: true }).pipe(Effect.orDie),
      ));

      return targets;
    }),
  };
}));
