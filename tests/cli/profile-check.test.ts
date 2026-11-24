import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkoutStatus } from "../../src/cli/checkout-reports.ts";
import { freshInitConfig } from "../../src/cli/init-state.ts";
import { profileCheckOutput, setupReadinessLines } from "../../src/cli/profile-check-output.ts";
import { collectProfileFindings } from "../../src/cli/profile-check.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { splitSettingsText } from "../../src/lib/server/profile/split-settings.ts";
import { type SnapshotStore, SnapshotStoreLive } from "../../src/lib/server/snapshot/store.ts";
import profile from "../fixtures/port-oracle/basic-run/inputs/profile.json";
import configured from "../oracle/basic-run/cli/operations/profile-check-configured.json";
import unconfigured from "../oracle/basic-run/cli/operations/profile-check.json";

const models = readFileSync(new URL("../fixtures/port-oracle/basic-run/inputs/models.toml", import.meta.url), "utf8");
const screen = readFileSync(new URL("../../config/title_exclusions.neutral.toml", import.meta.url), "utf8");
const layers = Layer.merge(ProfileFilesLive, SnapshotStoreLive).pipe(Layer.provideMerge(BunFileSystem.layer));

const withProfile = <A, E>(use: (root: string, directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | ProfileFiles | SnapshotStore>) => Effect.runPromise(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const directory = join(root, "local_only", "profiles", "invented");
  const split = yield* splitSettingsText(profile.preferences, screen);
  const config = (yield* freshInitConfig("invented")).replace('preferences = "preferences.toml"', 'preferences = "retired.toml"');
  yield* fs.makeDirectory(join(directory, "outbox"), { recursive: true });
  yield* fs.makeDirectory(join(root, "data"));
  yield* fs.writeFileString(join(root, "data", "nav.sqlite3"), "Metadata only, not a database.");

  for (const [name, content] of Object.entries({
    "profile.toml": config, "profile.md": profile.narrative, "filters.toml": split.filters,
    "judge.toml": split.judge, "screen.toml": split.screen,
  })) yield* fs.writeFileString(join(directory, name), content);

  return yield* use(root, directory);
}).pipe(Effect.scoped, Effect.provide(layers)));

test("matches both status and stored profile check stdout without a harness or a database open", () => withProfile((root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* ProfileFiles;
  const modelsPath = join(root, "local_only", "models.toml");
  const reads: string[] = [];
  const metadataChecks: string[] = [];

  const report = collectProfileFindings(root, "invented").pipe(Effect.provideService(ProfileFiles, {
    ...files,
    read: (physicalRoot, path) => Effect.sync(() => { reads.push(path); }).pipe(Effect.zipRight(files.read(physicalRoot, path))),
    check: (physicalRoot, path, kind) => Effect.sync(() => { metadataChecks.push(path); }).pipe(Effect.zipRight(files.check(physicalRoot, path, kind))),
  }));

  // Neither the retired default nor the configured path is consulted.
  yield* fs.symlink(modelsPath, join(directory, "preferences.toml"));
  yield* fs.symlink(modelsPath, join(directory, "retired.toml"));
  expect(profileCheckOutput(yield* report)).toEqual({ stdout: unconfigured.stdout, exitStatus: unconfigured.exit_status });
  yield* fs.writeFileString(modelsPath, models);
  expect(profileCheckOutput(yield* report)).toEqual({ stdout: configured.stdout, exitStatus: configured.exit_status });
  expect(reads).toEqual([...Array(2)].flatMap(() => [
    ...["profile.toml", "profile.md", "filters.toml", "judge.toml", "screen.toml"].map((name) => join(directory, name)), modelsPath,
  ]));
  expect(metadataChecks).toEqual([...Array(2)].flatMap(() => [directory, join(root, "data", "nav.sqlite3"), join(directory, "outbox")]));
})));

test("isolates invalid radius and missing or invalid Judge terms without hiding other findings", () => withProfile((root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const filters = join(directory, "filters.toml");
  const settings = yield* fs.readFileString(filters);
  yield* fs.writeFileString(filters, settings.replace(/^"?radius_km"?\s*=.*$/mu, 'radius_km = "invented-invalid"'));
  yield* fs.writeFileString(join(directory, "judge.toml"), '[jobs]\npreferred_terms = [false]\n');
  const found = yield* collectProfileFindings(root, "invented");

  expect(found).toMatchObject({
    profile_toml: { ok: true }, origin: { ok: true }, narrative: { ok: true }, source_db: { ok: true }, outbox: { ok: true },
    preferences: { ok: false }, radius: { ok: false }, occupations: { ok: false }, reviewer: { ok: false },
  });
  expect(profileCheckOutput(found).stdout).not.toContain("invented-invalid");
  yield* fs.writeFileString(join(directory, "judge.toml"), "[jobs]\npreferred_terms = []\n");
  expect((yield* collectProfileFindings(root, "invented")).occupations.ok).toBe(true);
  yield* fs.writeFileString(join(directory, "judge.toml"), "[jobs]\n");
  expect((yield* collectProfileFindings(root, "invented")).occupations.ok).toBe(false);
})));

test("status distinguishes a Source database that does not exist yet from an unsafe file path", () => withProfile((root) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = join(root, "data", "nav.sqlite3");
  const status = checkoutStatus({ root, explicit: "invented" });
  yield* fs.remove(source);
  yield* fs.writeFileString(join(root, "local_only", "models.toml"), models);
  const fresh = yield* status;
  expect(fresh.exitStatus).toBe(0);
  expect(fresh.stderr).toBe("The first refresh creates the Source database.\n");
  expect(profileCheckOutput(yield* collectProfileFindings(root, "invented")).exitStatus).toBe(0);
  yield* fs.makeDirectory(source);
  const invalid = yield* status;
  expect(invalid.stderr).toContain("Setup checks missing or invalid: source_db.");
  expect(invalid.stderr).not.toContain("first refresh");
  expect(invalid.stdout).toBe(fresh.stdout);
  yield* fs.remove(source, { recursive: true });
  yield* fs.symlink(join(root, "does-not-exist"), source);
  expect((yield* status).stderr).toBe(invalid.stderr);
})));

test("asks for a missing custom Source directory before it offers refresh", () => withProfile((root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const profilePath = join(directory, "profile.toml");
  const config = yield* fs.readFileString(profilePath);
  yield* fs.writeFileString(profilePath, config.replace("data/nav.sqlite3", "feeds/invented/nav.sqlite3"));
  yield* fs.writeFileString(join(root, "local_only", "models.toml"), models);
  const findings = collectProfileFindings(root, "invented");
  const lines = setupReadinessLines(yield* findings).join("\n");
  expect(lines).toContain("PENDING  source_db  The Source database directory does not exist.");
  expect(lines).toContain("Create the parent directory of paths.source_db");
  expect(lines).not.toContain("pulse refresh");
  const status = yield* checkoutStatus({ root, explicit: "invented" });
  expect(status.stderr).toContain("Create the parent directory of paths.source_db");
  expect(status.stderr).not.toContain("missing or invalid");
  yield* fs.makeDirectory(join(root, "feeds", "invented"), { recursive: true });
  expect(setupReadinessLines(yield* findings)).toContain("Get the first jobs: pulse refresh --no-publish");
})));

test("reports wrong file kinds and does not use a legacy alias as an active setting", () => withProfile((root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(join(root, "local_only", "models.toml"));
  const narrative = join(directory, "profile.md");
  yield* fs.remove(narrative);
  yield* fs.makeDirectory(narrative);
  const source = join(root, "data", "nav.sqlite3");
  yield* fs.remove(source);
  yield* fs.makeDirectory(source);
  const found = yield* collectProfileFindings(root, "invented");

  expect(found).toMatchObject({
    profile_toml: { ok: true }, narrative: { ok: false, message: "Profile text cannot be read." }, source_db: { ok: false }, reviewer: { ok: false },
    preferences: { ok: true }, outbox: { ok: true },
  });
  const config = join(directory, "profile.toml");
  yield* fs.writeFileString(config, (yield* fs.readFileString(config)).replace('preferences = "retired.toml"', 'preferences = "filters.toml"'));
  const aliased = yield* collectProfileFindings(root, "invented");
  expect(aliased).toMatchObject({ profile_dir: { ok: true }, profile_toml: { ok: false }, preferences: { ok: false }, origin: { ok: false } });
  expect(profileCheckOutput(aliased).stdout).not.toContain(directory);
})));

test.each(["invalid schedule", "retired path with trailing slash"] as const)("rejects %s before reading policy-dependent files", (testCase) => withProfile((root, directory) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* ProfileFiles;
  const configPath = join(directory, "profile.toml");
  const modelsPath = join(root, "local_only", "models.toml");
  const original = yield* fs.readFileString(configPath);
  let config = original + '\n[schedule]\nschedule = "nonsense"\n';

  if (testCase === "retired path with trailing slash") {
    config = original.replace('preferences = "retired.toml"', 'preferences = "retired/"').replace('profile = "profile.md"', 'profile = "retired/profile.md"');
    yield* fs.makeDirectory(join(directory, "retired"));
    yield* fs.writeFileString(join(directory, "retired", "profile.md"), profile.narrative);
  }

  yield* fs.writeFileString(configPath, config);
  yield* fs.writeFileString(modelsPath, models);
  const reads: string[] = [];

  const found = yield* collectProfileFindings(root, "invented").pipe(Effect.provideService(ProfileFiles, {
    ...files,
    read: (physicalRoot, path) => Effect.sync(() => { reads.push(path); }).pipe(Effect.zipRight(files.read(physicalRoot, path))),
  }));

  expect(reads).toEqual([configPath, modelsPath]);
  expect(found).toMatchObject({
    profile_dir: { ok: true }, profile_toml: { ok: false }, reviewer: { ok: true }, narrative: { ok: false }, preferences: { ok: false },
    origin: { ok: false }, radius: { ok: false }, occupations: { ok: false }, source_db: { ok: false }, outbox: { ok: false },
  });
})));
