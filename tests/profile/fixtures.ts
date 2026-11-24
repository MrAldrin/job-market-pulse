import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Layer, Scope } from "effect";
import { join } from "node:path";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { Profile, ProfileLive } from "../../src/lib/server/profile/service.ts";
import { SettingsConverter, SettingsConverterLive } from "../../src/lib/server/profile/split-settings.ts";
import { ProfileInitialization, ProfileInitializationLive } from "../../src/lib/server/profile/initialization.ts";

export const fixturePreferences = '[geography]\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\nradius_km = 40.0\npreferred_municipalities = ["Invented town"]\n[jobs]\npreferred_terms = ["developer"]\nallowed_occupation_categories = ["IT"]\nexcluded_title_terms = ["recruiter"]\n';
export const fixtureNarrative = "## Invented profile\nEnjoys building software and learning.\n";

export const profileServices = Layer.mergeAll(ProfileLive, SettingsConverterLive, ProfileInitializationLive).pipe(
  Layer.provideMerge(ProfileFilesLive), Layer.provideMerge(BunFileSystem.layer),
);

export type TestEnvironment = FileSystem.FileSystem | ProfileFiles | Profile | SettingsConverter | ProfileInitialization | Scope.Scope;

export const run = <A, E>(program: Effect.Effect<A, E, TestEnvironment>): Promise<A> => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(profileServices)));

// Every write below is inside a newly owned temporary root. Nothing uses local owner files.
export const syntheticLegacy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-" });
  const directory = join(root, "local_only", "profiles", "invented");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(join(directory, "outbox"), { mode: 0o700 });
  yield* fs.makeDirectory(join(root, "data"));
  yield* fs.makeDirectory(join(root, "inputs"));
  const config = Either.getOrThrow(initialProfileConfig("invented")).replace("data/REPLACE_WITH_SHARED_FEED.sqlite3", "data/source.sqlite3");
  const profileFile = join(directory, "profile.toml");
  const preferencesFile = join(directory, "preferences.toml");
  const narrativeFile = join(directory, "profile.md");
  const titleRules = join(root, "inputs", "title-rules.toml");
  const rules = yield* fs.readFileString("config/title_exclusions.neutral.toml");
  yield* fs.writeFileString(profileFile, config, { mode: 0o600 });
  yield* fs.writeFileString(preferencesFile, fixturePreferences, { mode: 0o600 });
  yield* fs.writeFileString(narrativeFile, fixtureNarrative, { mode: 0o600 });
  yield* fs.writeFileString(join(root, "data", "source.sqlite3"), "");
  yield* fs.writeFileString(titleRules, rules);

  return { root, directory, config, profileFile, preferencesFile, narrativeFile, titleRules, rules };
});

export const syntheticSplit = Effect.gen(function* () {
  const fixture = yield* syntheticLegacy;
  const converter = yield* SettingsConverter;
  yield* converter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules });

  return fixture;
});
