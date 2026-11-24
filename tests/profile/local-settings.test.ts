import { FileSystem } from "@effect/platform";
import { screenTermPattern } from "../../src/lib/title-screen-terms.ts";
import { Effect, Either, Layer } from "effect";
import { collectProfileFindings } from "../../src/cli/profile-check.ts";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildManifest, manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { olderReviewContext } from "../../src/lib/server/judge/history-context.ts";
import { JudgeModelPicker } from "../../src/lib/server/judge/model-picker.ts";
import { modelSettingsFile, ReviewerSettings, ReviewerSettingsLive } from "../../src/lib/server/judge/reviewers.ts";
import { profilePeriod } from "../../src/lib/server/orchestration/schedule-profile.ts";
import { installationLockPath, withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";
import { LocalProfileSettings, LocalProfileSettingsLive } from "../../src/lib/server/profile/local-settings.ts";
import { PostcodeAreaTag } from "../../src/lib/server/profile/postcode-area.ts";
import { PostcodeAreaError } from "../../src/lib/server/profile/errors.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { profileServices, syntheticSplit, type TestEnvironment } from "./fixtures.ts";

const candidate = { provider: "invented", model: "next/preview", efforts: ["high"] } as const;

const picker = Layer.succeed(JudgeModelPicker, {
  discoverPi: Effect.succeed([candidate]),
  test: (reviewer) => Effect.sync(() => {
    expect(reviewer).toMatchObject({ harness: "pi", provider: candidate.provider, model: candidate.model, effort: "high" });
  }),
});

const postcodeLookup = Layer.succeed(PostcodeAreaTag, {
  lookup: (postcode) => postcode === "0101"
    ? Effect.succeed({ postcode, poststed: "Invented village", latitude: 60, longitude: 10.25 })
    : Effect.fail(new PostcodeAreaError({ message: "Invented lookup failure" })),
});

const services = Layer.merge(LocalProfileSettingsLive, ReviewerSettingsLive).pipe(
  Layer.provide(Layer.merge(picker, postcodeLookup)), Layer.provideMerge(profileServices),
);

const run = <A, E>(program: Effect.Effect<A, E, TestEnvironment | LocalProfileSettings | ReviewerSettings>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(services)));

const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, directory } = yield* syntheticSplit;
  const modelPath = join(root, modelSettingsFile);
  const filterPath = join(directory, "filters.toml");

  const modelText = (yield* fs.readFileString("tests/fixtures/port-oracle/basic-run/inputs/models.toml"))
    .replace('screen = { harness = "pi", model = "openai/synthetic-pi-model"', 'screen = { harness = "claude-code", model = "invented-claude"');

  yield* fs.writeFileString(modelPath, modelText, { mode: 0o600 });

  return { target: { root, profileId: "invented" }, modelPath, modelText, filterPath, fs };
});

test("saving search mode changes only selection policy and keeps saved review bindings current", () => run(Effect.gen(function* () {
  const { target, fs } = yield* checkout;
  const { root, profileId } = target;
  const editor = yield* LocalProfileSettings;
  const profile = yield* Profile;
  const { bundle: before } = yield* profile.load(root, profileId);
  const path = before.paths.profile_file;
  const original = yield* fs.readFileString(path);
  const settings = yield* editor.read(target);

  expect(settings.search_mode.mode).toBe("passive");
  const { revision } = yield* editor.save(target, { kind: "search_mode", revision: settings.search_mode.revision, values: "active" });
  expect(yield* fs.readFileString(path)).toBe(original.replace('mode = "passive"', 'mode = "active"'));
  const saved = yield* editor.read(target);
  expect(saved.search_mode).toEqual({ revision, mode: "active" });
  expect(saved.schedule?.revision).toBe(revision);
  expect(yield* Effect.flip(editor.save(target, { kind: "search_mode", revision: settings.search_mode.revision, values: "passive" }))).toMatchObject({ code: "changed" });

  const { bundle: after } = yield* profile.load(root, profileId);
  expect(after.policy).toEqual({ ...before.policy, mode: "active", exceptional_only: false });
  const priorInputs = yield* profile.readPersonalInputs(root, before);
  const nextInputs = yield* profile.readPersonalInputs(root, after);
  const prior = yield* manifestCommon(profileId, priorInputs);
  const next = yield* manifestCommon(profileId, nextInputs);
  expect(next).toEqual(prior);
  const manifest = Either.getOrThrow(buildManifest(next, [], "2026-11-20T11:00:00Z"));
  const savedReview = { profile_fingerprint: prior.profile_fingerprint, prompt_version: "invented-prompt" };
  expect(olderReviewContext(savedReview, {}, manifest, "invented-prompt")).toBe(false);
})));

test("the existing readers see the saved values without changes to other settings", () => run(Effect.gen(function* () {
  const { target, modelPath, modelText, filterPath, fs } = yield* checkout;
  const editor = yield* LocalProfileSettings;
  const profile = yield* Profile;
  const reviewers = yield* ReviewerSettings;
  const before = yield* editor.read(target);
  const filters = (yield* profile.load(target.root, target.profileId)).settings.filters;
  const reviewersBefore = yield* reviewers.load(target.root);
  const filterText = yield* fs.readFileString(filterPath);
  expect(yield* fs.exists(installationLockPath(target.root))).toBe(false);
  expect(before.filters.excluded_title_terms).toEqual(["recruiter"]);
  expect(before.models.steps.screen).toEqual({ harness: "claude-code", provider: "anthropic", model: "invented-claude", effort: "medium" });
  const model = { kind: "model", step: "judge", revision: before.models.revision, harness: "pi", provider: "invented", model: "next/preview", effort: "high" } as const;
  const probe = { ...model, kind: "test_model" } as const;
  expect(before.models.pi_catalog).toBeNull();
  expect(yield* Effect.flip(editor.save(target, model))).toMatchObject({ code: "invalid" });
  expect(yield* Effect.flip(editor.testModel(target, probe))).toMatchObject({ code: "invalid" });
  expect(yield* editor.refreshModels(target)).toEqual([candidate]);
  expect((yield* editor.read(target)).models.pi_catalog).toEqual([candidate]);
  expect((yield* fs.stat(join(target.root, "local_only", "pi-model-catalog.json"))).mode & 0o777).toBe(0o600);
  expect(yield* Effect.flip(editor.save(target, { ...model, effort: "max" }))).toMatchObject({ code: "invalid" });
  yield* editor.testModel(target, probe);
  expect(yield* fs.readFileString(modelPath)).toBe(modelText);
  const { revision: modelRevision } = yield* editor.save(target, model);
  expect(yield* fs.readFileString(filterPath)).toBe(filterText);
  const reviewersAfter = yield* reviewers.load(target.root);
  expect(reviewersAfter).toEqual({ ...reviewersBefore, judge: { ...reviewersBefore.judge, provider: "invented", model: "next/preview", effort: "high" } });
  expect(yield* Effect.flip(editor.testModel(target, probe))).toMatchObject({ code: "changed" });
  const modelSaved = yield* fs.readFileString(modelPath);

  const values = ['"invented # title"', "nattarbeid"];
  const { revision: filterRevision } = yield* editor.save(target, { kind: "excluded_title_terms", revision: before.filters.revision, values });
  const current = yield* editor.read(target);
  expect(current.models.revision).toBe(modelRevision);
  expect(current.filters).toEqual({ ...before.filters, revision: filterRevision, excluded_title_terms: values });
  expect(yield* fs.readFileString(modelPath)).toBe(modelSaved);
  expect((yield* profile.load(target.root, target.profileId)).settings.filters).toEqual({
    ...filters, jobs: { ...filters.jobs, excluded_title_terms: values },
  });
  expect(yield* fs.readFileString(filterPath)).toContain("radius_km = 40.0");

  for (const path of [modelPath, filterPath]) expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
})));

test("profile, CLI readiness and scheduler readers load edited settings", () => run(Effect.gen(function* () {
  const { target, fs, filterPath } = yield* checkout;
  const { root, profileId } = target;
  const editor = yield* LocalProfileSettings;
  const profile = yield* Profile;
  const initial = yield* profile.load(root, profileId);
  const configPath = initial.bundle.paths.profile_file;
  const comments = "# Invented profile comment\n";
  const inlineComment = "# Invented cadence note";
  const legacy = comments + (yield* fs.readFileString(configPath)) + `cadence = "weekly" ${inlineComment}\n`;
  yield* fs.writeFileString(configPath, legacy);
  const before = yield* editor.read(target);

  if (!before.judge || !before.screen || !before.schedule || !before.narrative) throw new Error("Expected all invented settings files");
  const { revision, ...currentSchedule } = before.schedule;
  expect(yield* editor.save(target, { kind: "schedule", revision, values: currentSchedule })).toEqual({ revision });
  expect(yield* fs.readFileString(configPath)).toBe(legacy);

  const locationUpdate = { kind: "location", revision: before.filters.revision, values: { home_postcode: "0101", radius_km: 27.5 } } as const;
  const beforeLocation = yield* fs.readFileString(filterPath);
  const failed = yield* Effect.flip(editor.save(target, { ...locationUpdate, values: { ...locationUpdate.values, home_postcode: "0000" } }));
  expect(failed.message).toContain("No location was saved");
  expect(yield* fs.readFileString(filterPath)).toBe(beforeLocation);
  const { revision: locationRevision, location } = yield* editor.save(target, locationUpdate);
  expect(location).toEqual({ ...locationUpdate.values, place: "Invented village" });
  expect(yield* fs.readFileString(filterPath)).not.toMatch(/preferred_municipalities|nearby_municipalities|area_postcode/);

  const values = { excluded_municipalities: ["Invented south"], excluded_employers: ["Invented employer"], allowed_occupation_categories: ["Construction"] };
  yield* editor.save(target, { kind: "filters", revision: locationRevision, values });

  expect(yield* Effect.flip(editor.save(target, { kind: "excluded_title_terms", revision: before.filters.revision, values: [] })))
    .toMatchObject({ code: "changed" });
  const preferred_terms = ["furniture design"];
  yield* editor.save(target, { kind: "judge", revision: before.judge.revision, values: preferred_terms });
  const screen = { academic: ["invented fellow"], business_development: [], sales: ["invented seller"], tech_words: ["invented compiler"] };
  yield* editor.save(target, { kind: "screen", revision: before.screen.revision, values: screen });

  const schedule = { kind: "schedule", revision: before.schedule.revision, values: { expression: "every 2 weeks friday 16:00", anchor: "2026-11-13" } } as const;

  for (const anchor of [null, "2026-11-31", "2026-11-12"]) {
    expect(yield* Effect.flip(editor.save(target, { ...schedule, values: { ...schedule.values, anchor } }))).toMatchObject({ code: "invalid" });
  }

  expect((yield* editor.read(target)).schedule).toEqual(before.schedule);
  const { revision: scheduleRevision } = yield* editor.save(target, schedule);
  const updatedConfig = yield* fs.readFileString(configPath);
  expect(updatedConfig).toContain(comments);
  expect(updatedConfig).toContain(`\n${inlineComment}\n`);
  const narrative = "# Invented profile\nBuilds furniture and prefers workshop roles.\n";
  const narrativeUpdate = { kind: "narrative", revision: before.narrative.revision, values: narrative } as const;
  expect(yield* Effect.flip(editor.save(target, { ...narrativeUpdate, values: "<!-- placeholder -->" }))).toMatchObject({ code: "invalid" });
  yield* editor.save(target, narrativeUpdate);

  const loaded = yield* profile.load(root, profileId);
  expect(loaded.settings.filters).toEqual({ geography: {
    ...locationUpdate.values, home_label: "Invented village", origin_latitude: 60, origin_longitude: 10.25,
    origin_source: expect.stringContaining("Kartverket Postnummerområder"), excluded_municipalities: values.excluded_municipalities,
  }, jobs: {
    excluded_title_terms: before.filters.excluded_title_terms, excluded_employers: values.excluded_employers, allowed_occupation_categories: values.allowed_occupation_categories,
  } });
  expect(loaded.settings.judge).toEqual({ jobs: { preferred_terms } });
  expect(loaded.settings.screen).toEqual({
    academic: [screenTermPattern("invented fellow")], business_development: [],
    sales: [screenTermPattern("invented seller")], tech_words: [screenTermPattern("invented compiler")],
    version: initial.settings.screen.version,
  });
  expect(loaded.narrative).toBe(narrative);
  expect(loaded.bundle.paths).toEqual(initial.bundle.paths);
  expect(loaded.bundle.policy.cadence).toEqual({ kind: "fortnightly", anchor: schedule.values.anchor });
  const now = "2026-11-18T12:00:00+01:00";
  const period = yield* profilePeriod(root, profileId, { now, requireAnchor: true });
  expect(period).toMatchObject({ kind: "every_n_weeks", time: "16:00", anchor: schedule.values.anchor });
  expect(Object.values(yield* collectProfileFindings(root, profileId)).every((finding) => finding.ok)).toBe(true);
  const current = yield* editor.read(target);
  expect(current).toMatchObject({ filters: values, judge: { preferred_terms }, screen: { values: screen }, schedule: schedule.values, narrative: { text: narrative } });

  for (const path of [filterPath, loaded.bundle.paths.profile_file, loaded.bundle.paths.narrative_file]) {
    expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
  }

  yield* editor.save(target, { kind: "schedule", revision: scheduleRevision, values: { expression: "never", anchor: null } });
  expect((yield* Effect.flip(profilePeriod(root, profileId, { now }))).message).toContain("disabled");
})));

test("does not confirm a legacy place that belongs to a different postcode", () => run(Effect.gen(function* () {
  const { target, fs, filterPath } = yield* checkout;

  const original = (yield* fs.readFileString(filterPath)).replace("[geography]",
    '[geography]\nhome_postcode = "0101"\narea_postcode = "0202"\nhome_label = "0202 Invented old place"');

  yield* fs.writeFileString(filterPath, original);
  const editor = yield* LocalProfileSettings;

  const { filters } = yield* editor.read(target);

  expect(filters.location).toEqual({ home_postcode: "0101", radius_km: 40, place: null });
  expect(yield* fs.readFileString(filterPath)).toBe(original);

  const { location } = yield* editor.save(target, {
    kind: "location", revision: filters.revision, values: { home_postcode: "0101", radius_km: 40 },
  });

  expect(location).toEqual({ home_postcode: "0101", radius_km: 40, place: "Invented village" });
  expect((yield* editor.read(target)).filters.location).toEqual(location);
})));

test("unavailable profile inputs leave the other editor sections usable", () => run(Effect.gen(function* () {
  const { target, fs, filterPath } = yield* checkout;
  const directory = join(target.root, "local_only", "profiles", target.profileId);
  const narrative = join(directory, "profile.md");
  yield* fs.rename(narrative, join(target.root, "invented-moved.md"));
  yield* fs.writeFileString(join(directory, "judge.toml"), "invalid TOML");
  const editor = yield* LocalProfileSettings;
  const settings = yield* editor.read(target);
  expect(settings).toMatchObject({ narrative: null, judge: null, models: { steps: { judge: { harness: "pi" } } } });
  expect(settings.screen).not.toBeNull();
  expect(settings.schedule).not.toBeNull();
  yield* editor.save(target, { kind: "excluded_title_terms", revision: settings.filters.revision, values: ["invented filter"] });
  expect(yield* fs.readFileString(filterPath)).toContain("invented filter");
})));

test("a busy lock, stale file or symlink leaves saved settings unchanged", () => run(Effect.gen(function* () {
  const { target, modelPath, modelText, filterPath, fs } = yield* checkout;
  const editor = yield* LocalProfileSettings;
  const before = yield* editor.read(target);
  const filterText = yield* fs.readFileString(filterPath);
  const change = { kind: "excluded_title_terms", revision: before.filters.revision, values: [] } as const;
  const busy = yield* withInstallationLock(target.root, () => Effect.flip(editor.save(target, change)));
  expect(busy).toMatchObject({ code: "busy" });
  expect(yield* fs.readFileString(filterPath)).toBe(filterText);

  const modified = "# Other writer\n" + filterText;
  yield* fs.writeFileString(filterPath, modified);
  expect(yield* Effect.flip(editor.save(target, change))).toMatchObject({ code: "changed" });
  expect(yield* fs.readFileString(filterPath)).toBe(modified);

  const separate = join(target.root, "separate-filters.toml");
  yield* fs.rename(filterPath, separate);
  yield* fs.symlink(separate, filterPath);
  expect(yield* Effect.flip(editor.read(target))).toMatchObject({ code: "unavailable" });
  expect(yield* Effect.flip(editor.save(target, change))).toMatchObject({ code: "unavailable" });
  expect(yield* fs.readFileString(separate)).toBe(modified);
  expect(yield* fs.readFileString(modelPath)).toBe(modelText);
})));
