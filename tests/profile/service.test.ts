import { FileSystem } from "@effect/platform";
import { Effect, Either, Layer } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { Profile, ProfileLive } from "../../src/lib/server/profile/service.ts";
import { ProfileInitialization } from "../../src/lib/server/profile/initialization.ts";
import { fixtureNarrative, fixturePreferences, run, syntheticSplit } from "./fixtures.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";

const id = "invented";

describe("Profile resource service", () => {
  it("loads a validated bundle and owned settings without reading a missing legacy file", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(fixture.preferencesFile);
    const profile = yield* Profile;
    const result = yield* profile.load(fixture.root, id);
    expect(result.bundle.profile_id).toBe(id);
    expect(result.bundle.paths.preferences_file).toBe(fixture.preferencesFile);
    expect(result.bundle.policy).toEqual({ mode: "passive", max_recommendations: 120, exceptional_only: true, market_only: false, timezone: "Europe/Oslo", freshness_max_age: { $seconds: 86400 }, cadence: { kind: "weekly", anchor: null } });
    expect(result.settings.preferences.preferred_terms).toEqual(["developer"]);
    expect(result.settings.preferences.radius_km).toBe(40);
    expect(result.settings.profile_fingerprint).toBe(sha256(fixtureNarrative));
    const filters = join(fixture.directory, "filters.toml");
    const judge = join(fixture.directory, "judge.toml");
    yield* fs.writeFileString(filters, "# An annotation\n\n" + (yield* fs.readFileString(filters)));
    yield* fs.writeFileString(judge, (yield* fs.readFileString(judge)).replace("[jobs]", "[jobs] # Another annotation"));
    yield* fs.writeFileString(join(fixture.directory, "screen.toml"), "# A comment\n\n" + fixture.rules.replaceAll("=", " = "));
    const formatted = yield* profile.load(fixture.root, id);
    expect(formatted.settings.rules_fingerprint).toBe(result.settings.rules_fingerprint);
    expect(formatted.settings.preference_fingerprint).toBe(result.settings.preference_fingerprint);
    expect(formatted.settings.profile_fingerprint).toBe(result.settings.profile_fingerprint);
    expect(result.settings.preference_fingerprint).toBe("72def0a62532b740a1a143f22f26c385fd4a5fe964a727def2e77d6a314f417c");
    expect((yield* profile.inspect(fixture.root, id)).readiness).toBe("ready");
  })));
  it("never stats, opens, checks or reads poisoned legacy metadata", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(fixture.preferencesFile);
    yield* fs.symlink(join(fixture.root, "inputs", "nonexistent"), fixture.preferencesFile);
    const accesses: string[] = [];

    const guard = (path: string) => {
      if (path === fixture.preferencesFile) accesses.push(path);

      return path === fixture.preferencesFile;
    };

    const guardedFs = { ...fs,
      stat: (path: string) => guard(path) ? Effect.die("Legacy stat was attempted") : fs.stat(path),
      exists: (path: string) => guard(path) ? Effect.die("Legacy exists was attempted") : fs.exists(path),
      readLink: (path: string) => guard(path) ? Effect.die("Legacy symlink check was attempted") : fs.readLink(path),
      open: (path: string, options?: FileSystem.OpenFileOptions) => guard(path) ? Effect.die("Legacy open was attempted") : fs.open(path, options),
      readFile: (path: string) => guard(path) ? Effect.die("Legacy read was attempted") : fs.readFile(path),
    };

    const guarded = ProfileLive.pipe(Layer.provide(ProfileFilesLive.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, guardedFs)))));
    const profile = yield* Profile.pipe(Effect.provide(guarded));
    expect((yield* profile.load(fixture.root, id)).bundle.paths.preferences_file).toBe(fixture.preferencesFile);
    expect((yield* profile.inspect(fixture.root, id)).readiness).toBe("ready");
    expect(accesses).toEqual([]);
  })));
  it.each(["../escape", "/absolute", "x\\bad", ".", "profile.toml", "outbox/child", "filters.toml"])("rejects unsafe or overlapping private path %j", async (path) => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(fixture.profileFile, fixture.config.replace('profile = "profile.md"', `profile = ${JSON.stringify(path)}`));
    const profile = yield* Profile;
    expect(Either.isLeft(yield* Effect.either(profile.inspect(fixture.root, id)))).toBe(true);
  })));
  it("guards source paths and file kinds", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const profile = yield* Profile;
    yield* fs.writeFileString(fixture.profileFile, fixture.config.replace("data/source.sqlite3", "local_only/source.sqlite3"));
    expect(Either.isLeft(yield* Effect.either(profile.inspect(fixture.root, id)))).toBe(true);
    yield* fs.writeFileString(fixture.profileFile, fixture.config);
    const source = join(fixture.root, "data", "source.sqlite3");
    yield* fs.remove(source);
    yield* fs.makeDirectory(source);
    expect(Either.isLeft(yield* Effect.either(profile.inspect(fixture.root, id)))).toBe(true);
  })));
  it("reports ordered readiness reasons and permits cadence access while not ready", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const profile = yield* Profile;
    const source = join(fixture.root, "data", "source.sqlite3");
    yield* fs.remove(source);
    expect((yield* profile.inspect(fixture.root, id)).readiness_reason).toBe("shared source database is missing");
    expect((yield* profile.cadence(fixture.root, id)).kind).toBe("weekly");
    yield* fs.writeFileString(source, "");
    yield* fs.writeFileString(join(fixture.directory, "filters.toml"), "# empty\n");
    yield* fs.writeFileString(join(fixture.directory, "judge.toml"), "# empty\n");
    expect((yield* profile.inspect(fixture.root, id)).readiness_reason).toBe("private preferences are still a placeholder");

    for (const empty of ['[geography]\nhome_postcode = ""', '[geography]\npreferred_municipalities = []', '[jobs]\nexcluded_title_terms = []']) {
      yield* fs.writeFileString(join(fixture.directory, "filters.toml"), empty);
      expect((yield* profile.inspect(fixture.root, id)).readiness_reason).toBe("private preferences are still a placeholder");
    }

    yield* fs.writeFileString(join(fixture.directory, "judge.toml"), '[jobs]\npreferred_terms = ["x"]');
    yield* fs.writeFileString(fixture.narrativeFile, "# Profile\n<!-- placeholder -->\nNot stated.\n");
    expect((yield* profile.inspect(fixture.root, id)).readiness_reason).toBe("private narrative profile is still a placeholder");
    yield* fs.writeFileString(fixture.narrativeFile, fixtureNarrative);
    yield* fs.remove(join(fixture.directory, "outbox"), { recursive: true });
    expect((yield* profile.inspect(fixture.root, id)).readiness_reason).toBe("profile outbox directory is missing");
    expect(Either.isLeft(yield* Effect.either(profile.load(fixture.root, id)))).toBe(true);
  })));
  it("rejects incomplete origin and malformed private UTF8 without exposing contents", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const profile = yield* Profile;
    yield* fs.writeFileString(join(fixture.directory, "filters.toml"), '[geography]\norigin_latitude = 60');
    expect((yield* profile.inspect(fixture.root, id)).readiness).toBe("not-ready");
    yield* fs.writeFileString(join(fixture.directory, "filters.toml"), '[jobs]\nexcluded_employers = ["synthetic"]');
    yield* fs.writeFile(fixture.narrativeFile, new Uint8Array([255]));
    const result = yield* Effect.either(profile.load(fixture.root, id));
    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) expect(result.left.message).not.toContain("synthetic");
  })));
  it("uses all file chunks, strict UTF8 and unchanged BOM/newline bytes", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const narrative = "\ufeff# Profile\r\n" + "Synthetic work.\r\n".repeat(2000);
    yield* fs.writeFileString(fixture.narrativeFile, narrative);
    const files = yield* ProfileFiles;
    expect(yield* files.read(fixture.root, fixture.narrativeFile)).toBe(narrative);
    expect(Either.isLeft(yield* Effect.either(files.read(fixture.root, fixture.narrativeFile, 10)))).toBe(true);
    const profile = yield* Profile;
    expect((yield* profile.load(fixture.root, id)).settings.profile_fingerprint).toBe(sha256(narrative));
  })));
  it("atomically changes mode with private permissions, but does not rewrite other bytes", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const profile = yield* Profile;
    yield* fs.writeFileString(fixture.profileFile, fixture.config.replace('mode = "passive"', "mode = 'passive' # exact comment"));
    const before = yield* fs.readFileString(fixture.profileFile);
    yield* fs.chmod(fixture.profileFile, 0o644);
    yield* profile.setMode(fixture.root, id, "active");
    expect(yield* fs.readFileString(fixture.profileFile)).toBe(before.replace("mode = 'passive'", "mode = 'active'"));
    expect((yield* fs.stat(fixture.profileFile)).mode & 0o777).toBe(0o600);
    expect((yield* profile.load(fixture.root, id)).bundle.policy.exceptional_only).toBe(false);
    expect(yield* fs.readFileString(fixture.preferencesFile)).toBe(fixturePreferences);
  })));
  it.each(['"20261116"', '"2026W471"', '"2026-W47-1"', '20261116', '2026-11-16'])("loads saved schedule anchor %s through the enclosing Profile boundary", async (anchor) => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    const text = fixture.config + '\n[schedule]\nschedule = "every 2 weeks mon"\nanchor = ' + anchor + '\n';
    yield* fs.writeFileString(fixture.profileFile, text);
    const profile = yield* Profile;
    expect((yield* profile.load(fixture.root, id)).bundle.profile_id).toBe(id);
    expect((yield* profile.inspect(fixture.root, id)).readiness).toBe("ready");
    expect(yield* profile.cadence(fixture.root, id)).toEqual({ kind: "weekly", anchor: null });
    expect(yield* fs.readFileString(fixture.profileFile)).toBe(text);
  })));

  it.each(['"20260230"', '"2026W999"', '"20261117"', '20261116.0', '[20261116]', '{ value = "20261116" }', 'true', '2026-11-16T09:00:00Z'])("rejects invalid saved schedule token %s without coercing it to a basic date", async (anchor) => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(fixture.profileFile, fixture.config + '\n[schedule]\nschedule = "every 2 weeks mon"\nanchor = ' + anchor + '\n');
    const profile = yield* Profile;
    expect(Either.isLeft(yield* profile.load(fixture.root, id).pipe(Effect.either))).toBe(true);
  })));

  it("initializes private split placeholders without a legacy preference file", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-init-" });
    const initializer = yield* ProfileInitialization;
    const paths = yield* initializer.create(root, id, "academic = []\n");
    const profile = yield* Profile;
    expect((yield* profile.inspect(root, id)).readiness_reason).toBe("shared source database is missing");
    expect(yield* fs.exists(paths.preferences_file)).toBe(false);
    expect((yield* fs.stat(paths.directory)).mode & 0o777).toBe(0o700);

    for (const name of ["profile.toml", "profile.md", "filters.toml", "screen.toml", "judge.toml"]) expect((yield* fs.stat(join(paths.directory, name))).mode & 0o777).toBe(0o600);

    expect(Either.isLeft(yield* Effect.either(initializer.create(root, id, "")))).toBe(true);
    expect(Either.isLeft(yield* Effect.either(initializer.create(root, "bad/slug", "")))).toBe(true);
  })));
});
