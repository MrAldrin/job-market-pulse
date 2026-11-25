import { FileSystem } from "@effect/platform";
import { Effect, Either, Layer } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileFiles } from "../../src/lib/server/profile/files.ts";
import { ProfileError } from "../../src/lib/server/profile/errors.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { SettingsConverter, SettingsConverterLive } from "../../src/lib/server/profile/split-settings.ts";
import { fixturePreferences, run, syntheticLegacy } from "./fixtures.ts";

const names = ["filters.toml", "screen.toml", "judge.toml"];

describe("explicit legacy settings converter", () => {
  it("writes only three private files, keeps inputs and exact title bytes, and preserves identity", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticLegacy;
    const fs = yield* FileSystem.FileSystem;
    const converter = yield* SettingsConverter;
    const written = yield* converter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules });
    expect(written).toEqual(names.map((name) => join(fixture.directory, name)));
    expect(yield* fs.readFileString(fixture.preferencesFile)).toBe(fixturePreferences);
    expect(yield* fs.readFileString(fixture.profileFile)).toBe(fixture.config);
    expect(yield* fs.readFileString(join(fixture.directory, "screen.toml"))).toBe(fixture.rules);

    for (const path of written) {
      const info = yield* fs.stat(path);
      expect(info.type).toBe("File");

      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
    }

    const profile = yield* Profile;
    const result = yield* profile.load(fixture.root, "invented");
    expect(result.settings.preference_fingerprint).toBe("72def0a62532b740a1a143f22f26c385fd4a5fe964a727def2e77d6a314f417c");
    expect(result.bundle.paths.preferences_file).toBe(fixture.preferencesFile);
  })));
  it.each(names)("preflights all outputs before writing when %s exists", async (name) => run(Effect.gen(function* () {
    const fixture = yield* syntheticLegacy;
    const fs = yield* FileSystem.FileSystem;
    const target = join(fixture.directory, name);
    yield* fs.writeFileString(target, "SYNTHETIC DO NOT OVERWRITE");
    const converter = yield* SettingsConverter;
    expect(Either.isLeft(yield* Effect.either(converter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules })))).toBe(true);

    for (const output of names) expect(yield* fs.exists(join(fixture.directory, output))).toBe(output === name);

    expect(yield* fs.readFileString(target)).toBe("SYNTHETIC DO NOT OVERWRITE");
    expect(yield* fs.readFileString(fixture.preferencesFile)).toBe(fixturePreferences);
  })));
  it("reads only an explicitly selected base, preserves integer identity and explicit empty override", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticLegacy;
    const fs = yield* FileSystem.FileSystem;
    const base = join(fixture.root, "inputs", "selected-base.toml");
    yield* fs.writeFileString(base, '[geography]\nradius_km = 12\n[jobs]\npreferred_terms = ["inherited"]\nexcluded_employers = ["Base employer"]\n');
    yield* fs.writeFileString(fixture.preferencesFile, '[jobs]\npreferred_terms = []\nexcluded_title_terms = ["synthetic"]\n');
    const converter = yield* SettingsConverter;
    yield* converter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules, defaults: base });
    expect(yield* fs.readFileString(join(fixture.directory, "filters.toml"))).toContain("radius_km = 12\n");
    const profile = yield* Profile;
    const loaded = yield* profile.load(fixture.root, "invented");
    expect(loaded.settings.preferences.preferred_terms).toEqual([]);
    expect(loaded.settings.preferences.excluded_employers).toEqual(["Base employer"]);
    expect(loaded.settings.filters.geography?.radius_km).toBe(12n);
    yield* fs.remove(base);
    yield* fs.remove(fixture.preferencesFile);
    expect((yield* profile.load(fixture.root, "invented")).settings.preference_fingerprint).toBe(loaded.settings.preference_fingerprint);
  })));
  it("validates every input before writing and rolls back its own completed files on I/O failure", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticLegacy;
    const fs = yield* FileSystem.FileSystem;
    const converter = yield* SettingsConverter;
    yield* fs.writeFileString(fixture.titleRules, "unknown = true");
    expect(Either.isLeft(yield* Effect.either(converter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules })))).toBe(true);

    for (const name of names) expect(yield* fs.exists(join(fixture.directory, name))).toBe(false);

    yield* fs.writeFileString(fixture.titleRules, fixture.rules);
    const files = yield* ProfileFiles;
    let count = 0;

    const failedFiles = Layer.succeed(ProfileFiles, { ...files, create: (root, path, text) => {
      count++;

      return count === 2 ? Effect.fail(new ProfileError({ message: "Synthetic disk failure" })) : files.create(root, path, text);
    } });

    const failingConverter = yield* SettingsConverter.pipe(Effect.provide(SettingsConverterLive.pipe(Layer.provide(failedFiles))));
    expect(Either.isLeft(yield* Effect.either(failingConverter.split({ root: fixture.root, profileId: "invented", titleRules: fixture.titleRules })))).toBe(true);

    for (const name of names) expect(yield* fs.exists(join(fixture.directory, name))).toBe(false);

    expect(yield* fs.readFileString(fixture.preferencesFile)).toBe(fixturePreferences);
    expect((yield* fs.readDirectory(fixture.directory)).some((name) => name.startsWith(".split-settings-"))).toBe(false);
  })));
});
