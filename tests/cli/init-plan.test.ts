import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { setupDefaults } from "../../src/cli/init-defaults.ts";
import { planInitProfileMode, reviewInitPlan } from "../../src/cli/init-plan.ts";
import { initFingerprints, prepareInitInputs, recordInitInterviewFacts, saveInitCheckpoint } from "../../src/cli/init-recovery.ts";
import { bindInitProfile, freshInitConfig, isInitTomlTable, loadInitState } from "../../src/cli/init-state.ts";
import { maxInterviewContextBytes } from "../../src/cli/interview-session.ts";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { decodeFilters, decodeJudge } from "../../src/lib/server/profile/settings.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";
import { parseToml } from "../../src/lib/server/shared/toml.ts";
import { setWindowsFixturePublicRead } from "../orchestration/windows-acl-fixture.ts";

const dir = "local_only/profiles/invented";
const recovery = "local_only/init-answers.toml";
const selector = "local_only/pulse.toml";
const models = "local_only/models.toml";
const scope = { step: undefined, advanced: false, dryRun: false };
const roots: string[] = [];
const layers = ProfileFilesLive.pipe(Layer.provideMerge(BunFileSystem.layer));
const run = <A, E>(effect: Effect.Effect<A, E, ProfileFiles | FileSystem.FileSystem>) => Effect.runPromise(effect.pipe(Effect.provide(layers)));

const allow = {
  dryRun: false, nonInteractive: false,
  replace: (_path: string) => Effect.succeed(true), save: () => Effect.succeed(true),
};

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "pulse-init-plan-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const put = async (root: string, name: string, content: string | Uint8Array, mode = 0o600) => {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
};

const get = (root: string, name: string) => readFile(join(root, name), "utf8");
const config = (id = "invented") => run(freshInitConfig(id));
const seed = async (root: string, id = "invented") => put(root, `local_only/profiles/${id}/profile.toml`, await config(id));

const fresh = (root: string) => run(loadInitState(root).pipe(Effect.flatMap((state) => bindInitProfile(state, "invented"))));

const noConsent = { replace: (_path: string) => Effect.die("unexpected replacement prompt"), save: () => Effect.die("unexpected save prompt") };

const traceRead = <A, E>(effect: Effect.Effect<A, E, ProfileFiles | FileSystem.FileSystem>, trace: string[]) => Effect.gen(function* () {
  const resource = yield* FileSystem.FileSystem;

  const guard = FileSystem.FileSystem.of({ ...resource, readFile: (path) => {
    trace.push(path);

    return resource.readFile(path);
  } });

  return yield* effect.pipe(Effect.provide(ProfileFilesLive), Effect.provideService(FileSystem.FileSystem, guard));
}).pipe(Effect.provide(BunFileSystem.layer), Effect.runPromise);

test("selects only the explicit existing profile and never looks up the retired file or stores", async () => {
  const root = await temporaryRoot();
  await seed(root);
  await put(root, "local_only/profiles/other/profile.toml", "not TOML");
  await put(root, selector, 'profile = "other"\n');
  await symlink("absent", join(root, dir, "preferences.toml"));
  await symlink("absent", join(root, dir, "review.sqlite3"));
  const trace: string[] = [];
  const state = await traceRead(loadInitState(root, "invented"), trace);
  expect(state.profile?.id).toBe("invented");
  expect(trace).toEqual([join(root, selector), join(root, dir, "profile.toml")]);
  expect(state.createSelector).toBe(false);
  await expect(run(loadInitState(root, "another"))).rejects.toThrow("Creating another profile is not supported");
  await rm(join(root, selector));
  await expect(run(loadInitState(root))).rejects.toThrow("Profile selection is ambiguous");
  await rm(join(root, "local_only/profiles/other"), { recursive: true });
  expect((await run(loadInitState(root))).createSelector).toBe(true);
  expect(await readdir(join(root, "local_only"))).toEqual(["profiles"]);
});

test("accepts standalone named TOML and rejects direct and aliased managed paths before reading contents", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const standalone = join(root, "standalone.toml");
  await put(root, "standalone.toml", '[answers]\nprofile_id = "invented"\nsearch_mode = "active"\n');
  await put(root, `${dir}/private.toml`, 'profile_id = "invented"\n');
  const alias = join(root, "alias.toml");
  await symlink(join(root, dir, "private.toml"), alias);
  const request = { ...scope, root, resume: false };
  const result = await run(prepareInitInputs({ ...request, answersPath: standalone }));
  expect(result.answers).toEqual({ profile_id: "invented", search_mode: "active" });
  expect(result.state.profile?.id).toBe("invented");
  await expect(run(prepareInitInputs({ ...request, answersPath: standalone, profile: "other" }))).rejects.toThrow("Conflicting explicit profile IDs");

  const standaloneAlias = join(root, "standalone-alias.toml");
  await symlink(standalone, standaloneAlias);
  expect((await run(prepareInitInputs({ ...request, answersPath: standaloneAlias }))).answers).toEqual(result.answers);
  const traceMissing: string[] = [];
  // Windows resolves dot segments before opening the file. On POSIX a missing
  // intermediate directory must stop the lookup even if the normalized file exists.
  const missing = process.platform === "win32" ? join(root, "missing.toml") : `${root}/missing/../standalone.toml`;
  await expect(traceRead(prepareInitInputs({ ...request, answersPath: missing }), traceMissing)).rejects.toThrow("Setup answers could not be read as TOML.");
  expect(traceMissing).toEqual([]);

  const managedPaths = [`${root}/${dir}/missing/../private.toml`, alias];

  if (process.platform === "win32") managedPaths.push(join(root, "LOCAL_ONLY", "Profiles", "invented", "PRIVATE.TOML"));

  for (const answersPath of managedPaths) {
    const trace: string[] = [];
    await expect(traceRead(prepareInitInputs({ ...request, answersPath }), trace), answersPath).rejects.toThrow("standalone answers file");
    expect(trace).toEqual([]);
  }
});

// A junction gives the managed directory a different physical path even on
// NTFS volumes where short-name generation is disabled.
if (process.platform === "win32") test("refuses answers at the physical target of a managed directory junction", async () => {
  const root = await temporaryRoot();
  const target = join(root, "relocated");
  const path = join(target, "private.toml");
  await put(root, "relocated/private.toml", 'profile_id = "invented"\n');
  await mkdir(join(root, "local_only"));
  await symlink(target, join(root, "local_only", "profiles"), "junction");
  const trace: string[] = [];

  await expect(traceRead(prepareInitInputs({ ...scope, root, resume: false, answersPath: path }), trace)).rejects.toThrow("standalone answers file");
  expect(trace).toEqual([]);
});

test("projects only selected committed inputs to stable named defaults", async () => {
  const root = await temporaryRoot();
  const text = await config();
  await put(root, `${dir}/profile.toml`, text + '\n[schedule]\nschedule = "every 2 weeks mon 15:00"\nanchor = 2026-10-05\n');
  await put(root, `${dir}/filters.toml`, '[geography]\narea_postcode = "0123"\nhome_label = "0123 INVENTED"\nradius_km = 40.0\npreferred_municipalities = ["not a setup answer"]\n[jobs]\nallowed_occupation_categories = ["IT / Utvikling"]\nexcluded_employers = ["one, two"]\n');
  await put(root, `${dir}/judge.toml`, '[jobs]\npreferred_terms = ["inventory"]\n');
  await put(root, models, await readFile("tests/oracle/setup-interview/setup/files/models.toml"));
  const state = await run(loadInitState(root));
  const result = await run(setupDefaults(state, [{ name: "IT", plain: "IT", level2: ["Support", "Utvikling"] }], "2026-10-19"));

  expect(result).toEqual({
    profile_id: 'invented', search_mode: 'passive', radius_km: 40, home_label: '0123 INVENTED', area_postcode: '0123',
    place_query: '0123', radius_input: '40.0', preferred_terms: ['inventory'], preferred_terms_input: 'inventory',
    excluded_employers: ['one, two'], excluded_employers_input: 'one, two',
    allowed_occupation_categories: ['IT / Utvikling'], occupation_IT_mode: 'some', occupation_IT_parts: '2', occupation_choices: '1',
    screen_harness: 'pi', screen_model: 'synthetic/fixed', screen_effort: 'medium', screen_batch_size: 20n,
    judge_harness: 'pi', judge_model: 'synthetic/fixed', judge_effort: 'medium', judge_batch_size: 5n,
    rejudge_harness: 'pi', rejudge_model: 'synthetic/fixed', rejudge_effort: 'medium', rejudge_batch_size: 5n,
    calibrate_harness: 'pi', calibrate_model: 'synthetic/fixed', calibrate_effort: 'medium', calibrate_batch_size: 1n,
    schedule_choice: 'every 2 weeks', schedule_period: 'every 2 weeks mon 15:00', schedule_normalized: 'every 2 weeks mon 15:00',
    schedule_time: '15:00', schedule_count: '2', schedule_weekday: 'monday', schedule_anchor: '2026-10-05',
  });
});

test("oversize narrative keeps only exact identity and refuses replacement or backup", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const path = join(dir, "profile.md");
  const prefix = Buffer.alloc(maxInterviewContextBytes, 0x61);
  const original = Buffer.concat([prefix, Buffer.from("A")]);
  const changed = Buffer.concat([prefix, Buffer.from("B")]);
  await put(root, path, original);
  const trace: string[] = [];
  const state = await traceRead(loadInitState(root), trace);
  const hashes = await run(initFingerprints(state));

  expect(trace).not.toContain(join(root, path));
  const expectedMode = process.platform === "win32" ? (await stat(join(root, path))).mode & 0o7777 : 0o600;
  expect(state.profile?.files.narrative.original).toEqual({ mode: expectedMode, digest: sha256(original) });
  expect(hashes[path]).toBe(sha256(original));
  await expect(run(reviewInitPlan(state, {
    narrative: { path, content: "Replacement", mode: 0o600, overwrite: true, expectedDigest: sha256(original) },
  }))).rejects.toThrow("too large to replace or back up");
  expect((await readdir(join(root, dir))).toSorted()).toEqual(["profile.md", "profile.toml"]);
  expect(await readFile(join(root, path))).toEqual(original);

  await run(saveInitCheckpoint(state, scope, { profile_id: "invented" }, "step"));
  const resume = { root, ...scope, resume: true };
  expect((await run(prepareInitInputs(resume))).state.profile?.id).toBe("invented");
  await put(root, path, changed);
  expect((await run(initFingerprints(state, true)))[path]).toBe(sha256(changed));
  await expect(run(prepareInitInputs(resume))).rejects.toThrow("Recovery does not match");

  const current = await run(loadInitState(root));
  const unrelated = await run(reviewInitPlan(current, { split: { excluded_employers: ["Invented"] } }));
  expect(await run(unrelated.apply({ ...allow, replace: noConsent.replace }))).toBe("applied");
  expect(await readFile(join(root, path))).toEqual(changed);
  expect((await readdir(join(root, dir))).toSorted()).toEqual(["filters.toml", "profile.md", "profile.toml"]);
});

test("refuses invalid projected split or shared settings before reviewing a write plan", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);

  for (const split of [{ radius_km: 0 }, { origin_latitude: 60 }]) {
    await expect(run(reviewInitPlan(state, { profileStep: true, split }))).rejects.toThrow();
  }

  await expect(run(reviewInitPlan(state, { profileStep: true, models: "# missing required stages\n" }))).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

test("previews fresh setup without prompts, directories, checkpoints, or early initialization", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);
  const reviewed = await run(reviewInitPlan(state, { profileStep: true, split: { preferred_terms: ["analysis, tools"] } }));
  expect(reviewed.entries.map(({ path }) => path)).toEqual([
    `${dir}/profile.toml`, `${dir}/outbox`, selector, `${dir}/filters.toml`, `${dir}/judge.toml`, `${dir}/screen.toml`,
  ].map((path) => join(path)));
  expect(await run(reviewed.apply({ ...noConsent, dryRun: true, nonInteractive: false }))).toBe("dry-run");
  expect(await run(reviewed.apply({ ...noConsent, dryRun: false, nonInteractive: true }))).toBe("needs-terminal");
  expect(await run(saveInitCheckpoint(state, { ...scope, dryRun: true }, {}, "step"))).toBe("dry-run");
  expect(await run(saveInitCheckpoint(state, scope, {}, "interview"))).toBe("memory-only");
  expect(await readdir(root)).toEqual([]);
});

test("fresh writes match config and selector bytes, with derived split values and only tracked neutral Screen", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);

  if (!state.profile) throw new Error("Missing fresh profile");

  const goldenConfig = await readFile("tests/oracle/setup-interview/setup/files/profiles/invented/profile.toml", "utf8");
  const expectedBase = goldenConfig.split("\n[schedule]")[0];
  expect(state.profile.configText).toBe(expectedBase);

  const originSource = "Kartverket Postnummerområder, catalogue-reported CC BY 4.0, EPSG:4326, approximate interior-chord midpoint, looked up 2026-10-19";

  const reviewed = await run(reviewInitPlan(state, {
    profileStep: true, config: state.profile.configText + '\n[schedule]\nschedule = "never"\n',
    split: { area_postcode: "0123", home_label: "0123 INVENTED", origin_latitude: 60, origin_longitude: 10, origin_source: originSource, radius_km: 40, allowed_occupation_categories: ["IT"], preferred_terms: [] },
  }));

  expect(await run(reviewed.apply({ ...allow, replace: noConsent.replace }))).toBe("applied");
  expect(await get(root, `${dir}/profile.toml`)).toBe(goldenConfig);
  expect(await get(root, selector)).toBe(await readFile("tests/oracle/setup-interview/setup/files/pulse.toml", "utf8"));
  expect(await get(root, `${dir}/screen.toml`)).toBe(await readFile("config/title_exclusions.neutral.toml", "utf8"));
  expect(await run(decodeFilters(await get(root, `${dir}/filters.toml`)))).toEqual({
    geography: { home_label: "0123 INVENTED", origin_latitude: 60, origin_longitude: 10, origin_source: originSource, radius_km: 40 },
    jobs: { allowed_occupation_categories: ["IT"] },
  });
  expect(await run(decodeJudge(await get(root, `${dir}/judge.toml`)))).toEqual({ jobs: { preferred_terms: [] } });

  if (process.platform !== "win32") expect((await stat(join(root, dir, "outbox"))).mode & 0o777).toBe(0o700);

  if (process.platform !== "win32") expect((await stat(join(root, dir, "filters.toml"))).mode & 0o777).toBe(0o600);
  expect(await readdir(join(root, dir))).not.toContain("preferences.toml");
});

test("keeps exact unchanged private bytes and makes a private same-file backup after both fresh gates", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const filtersText = '# Keep CRLF\r\n[geography]\r\narea_postcode = "0123"\r\npreferred_municipalities = ["INVENTED"]\r\n[jobs]\r\nexcluded_employers = ["old"]\r\n';
  const judgeText = '# Keep exactly\r\n[jobs]\r\npreferred_terms = ["analysis, tools"]\r\n';
  const screenText = '# Existing personal Screen bytes\nversion = "custom"\n';
  await put(root, `${dir}/filters.toml`, filtersText);
  await put(root, `${dir}/judge.toml`, judgeText);
  await put(root, `${dir}/screen.toml`, screenText, 0o644);
  const inode = (await stat(join(root, dir, "judge.toml"))).ino;
  const state = await run(loadInitState(root));
  const unchanged = await run(reviewInitPlan(state, { split: { preferred_terms: ["analysis, tools"] } }));
  expect(await run(unchanged.apply({ ...allow, ...noConsent }))).toBe("unchanged");
  const reviewed = await run(reviewInitPlan(state, { split: { area_postcode: "", excluded_employers: ["new"] } }));
  const prompts: string[] = [];

  const replace = (path: string) => Effect.sync(() => {
    prompts.push(path);

    return true;
  });

  expect(await run(reviewed.apply({ ...allow, replace, save: () => Effect.succeed(false) }))).toBe("declined");
  expect(await get(root, `${dir}/filters.toml`)).toBe(filtersText);

  const save = () => Effect.sync(() => {
    prompts.push("save");

    return true;
  });

  expect(await run(reviewed.apply({ ...allow, replace, save }))).toBe("applied");
  const filtersPath = join(dir, "filters.toml");
  expect(prompts).toEqual([filtersPath, filtersPath, "save"]);
  const names = await readdir(join(root, dir));
  const backup = names.find((name) => name.startsWith("filters.toml.bak-"));

  if (backup === undefined) throw new Error("Missing filters backup");

  expect(backup).toMatch(/^filters\.toml\.bak-\d{8}T\d{12}Z$/);
  const backupPath = join(root, dir, backup);
  expect(await readFile(backupPath, "utf8")).toBe(filtersText);

  if (process.platform === "win32") await run(Effect.flatMap(ProfileFiles, (files) => files.verifyPrivateFile(root, backupPath)));
  else expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  expect(await run(parseToml(await get(root, `${dir}/filters.toml`)))).toEqual({ geography: { preferred_municipalities: ["INVENTED"] }, jobs: { excluded_employers: ["new"] } });
  expect(await get(root, `${dir}/judge.toml`)).toBe(judgeText);
  expect((await stat(join(root, dir, "judge.toml"))).ino).toBe(inode);
  expect(await get(root, `${dir}/screen.toml`)).toBe(screenText);

  if (process.platform !== "win32") expect((await stat(join(root, dir, "screen.toml"))).mode & 0o777).toBe(0o644);
});

test("refuses stale bytes or mode after final consent before writing any affected file", async () => {
  const root = await temporaryRoot();
  await seed(root);
  await put(root, models, await readFile("tests/oracle/setup-interview/setup/files/models.toml"));
  const state = await run(loadInitState(root));

  if (!state.profile) throw new Error("Missing selected profile");

  const active = await run(planInitProfileMode(state.profile, "active"));
  const planned = "# planned\n" + await get(root, models);
  const reviewed = await run(reviewInitPlan(state, { profileStep: true, config: active, models: planned }));

  const confirmed = (mutation: () => Promise<void>) => reviewed.apply({ ...allow, save: () => Effect.promise(async () => {
    await mutation();

    return true;
  }) });

  await expect(run(confirmed(() => chmod(join(root, models), process.platform === "win32" ? 0o444 : 0o644)))).rejects.toThrow("changed during confirmation");
  await chmod(join(root, models), 0o600);
  await expect(run(confirmed(() => put(root, models, "# edited\n")))).rejects.toThrow("changed during confirmation");
  expect(await get(root, `${dir}/profile.toml`)).toBe(await config());
  expect(await readdir(join(root, dir))).toEqual(["profile.toml"]);
  expect(await readdir(join(root, "local_only"))).toEqual(["models.toml", "profiles"]);
});

test("refuses changed custom narrative, wrong file kind and a legacy alias without writing", async () => {
  const root = await temporaryRoot();
  const custom = (await config()).replace('profile = "profile.md"', 'profile = "notes/text.md"');
  await put(root, `${dir}/profile.toml`, custom);
  await put(root, `${dir}/notes/text.md`, "original");
  const state = await run(loadInitState(root));
  const narrative = { path: join(dir, "notes", "text.md"), content: "planned", mode: 0o600 as const, overwrite: true, expectedDigest: sha256("other") };
  await expect(run(reviewInitPlan(state, { narrative }))).rejects.toThrow("changed during the interview");
  await rm(join(root, dir, "notes/text.md"));
  await mkdir(join(root, dir, "notes/text.md"));
  await expect(run(loadInitState(root))).rejects.toThrow("wrong file kind");
  await put(root, `${dir}/profile.toml`, custom.replace('preferences = "preferences.toml"', 'preferences = "filters.toml"'));
  await expect(run(loadInitState(root))).rejects.toThrow("overlaps retired preferences storage");
});

test("checkpoints only matching v1 setup, merges explicit over recovered and refuses exact key/hash changes", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);
  const request = { ...scope, root, resume: true };

  const checkpoint = recordInitInterviewFacts({ profile_id: "invented", place_query: "0123", origin_latitude: 60 }, {
    interview_current_role: "invented work", interview_current_role_followup_index: 1,
  });

  expect(await run(saveInitCheckpoint(state, scope, checkpoint, "step"))).toBe("saved");

  if (process.platform !== "win32") expect((await stat(join(root, recovery))).mode & 0o777).toBe(0o600);
  expect(await readdir(join(root, "local_only"))).toEqual(["init-answers.toml"]);
  const inode = (await stat(join(root, recovery))).ino;
  expect(await run(saveInitCheckpoint(state, scope, checkpoint, "step"))).toBe("unchanged");
  expect((await stat(join(root, recovery))).ino).toBe(inode);
  const path = join(root, "provided.toml");
  await put(root, "provided.toml", 'place_query = "9999"\ninterview_current_role = "explicit"\n');
  const resumed = await run(prepareInitInputs({ ...request, answersPath: path }));
  expect(resumed.state.profile?.id).toBe("invented");
  expect(resumed.answers).toMatchObject({ place_query: "9999", interview_current_role: "explicit", interview_current_role_followup_index: 1 });
  expect(resumed.answers).not.toHaveProperty("origin_latitude");
  const original = await get(root, recovery);
  await expect(run(prepareInitInputs({ ...request, advanced: true }))).rejects.toThrow("does not match");
  const key = JSON.stringify(join(dir, "filters.toml"));
  expect(original).toContain(key);
  const wrongKey = JSON.stringify(join(dir, "preferences.toml"));
  await put(root, recovery, original.replace(key, wrongKey));
  const old = await get(root, recovery);
  await expect(run(prepareInitInputs(request))).rejects.toThrow("without --resume");
  expect(await get(root, recovery)).toBe(old);
  await put(root, recovery, original);
  await put(root, models, await readFile("tests/oracle/setup-interview/setup/files/models.toml"));
  await expect(run(prepareInitInputs(request))).rejects.toThrow("does not match");
  expect(await get(root, recovery)).toBe(original);
});

test("finished recovery refreshes selected hashes and preserves frozen v1 bytes outside the approved hash map", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);
  const golden = await readFile("tests/oracle/setup-interview/setup/files/init-answers.toml", "utf8");
  const goldenInputs = await run(parseToml(golden));
  const reviewed = await run(reviewInitPlan(state, { profileStep: true }));
  await run(reviewed.apply(allow));
  const answers = goldenInputs.answers;

  if (!isInitTomlTable(answers)) throw new Error("Missing frozen answers table");

  expect(await run(saveInitCheckpoint(state, scope, answers, "finished"))).toBe("saved");
  const completed = await get(root, recovery);
  const omitHashes = (text: string) => text.replace(/^"fingerprints" = .*$/m, '"fingerprints" = <owned hashes>');
  expect(omitHashes(completed)).toBe(omitHashes(golden));
  const { metadata } = await run(parseToml(completed));

  if (!isInitTomlTable(metadata)) throw new Error("Missing saved recovery metadata");

  const hashes = metadata.fingerprints;
  expect(hashes).toEqual({
    [join(selector)]: sha256(await get(root, selector)),
    [join(models)]: "missing",
    [join(dir, "profile.toml")]: sha256(await get(root, `${dir}/profile.toml`)),
    [join(dir, "profile.md")]: "missing",
    [join(dir, "filters.toml")]: sha256(await get(root, `${dir}/filters.toml`)),
    [join(dir, "judge.toml")]: sha256(await get(root, `${dir}/judge.toml`)),
    [join(dir, "screen.toml")]: sha256(await get(root, `${dir}/screen.toml`)),
  });
  await expect(run(prepareInitInputs({ ...scope, root, resume: true }))).rejects.toThrow("does not match");
});

test("a destination created at the fresh final gate is not overwritten or accompanied by any setup writes", async () => {
  const root = await temporaryRoot();
  const state = await fresh(root);
  const planned = await readFile("tests/oracle/setup-interview/setup/files/models.toml", "utf8");
  const reviewed = await run(reviewInitPlan(state, { profileStep: true, models: planned }));

  const save = () => Effect.promise(async () => {
    await put(root, `${dir}/filters.toml`, "# created elsewhere\n");

    return true;
  });

  await expect(run(reviewed.apply({ ...allow, replace: noConsent.replace, save }))).rejects.toThrow("changed during confirmation");
  expect(await readdir(join(root, "local_only"))).toEqual(["profiles"]);
  expect(await readdir(join(root, dir))).toEqual(["filters.toml"]);
  expect(await get(root, `${dir}/filters.toml`)).toBe("# created elsewhere\n");
});

test("an unsafe permission change does not bypass the setup gates or leak a backup", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const content = '# Retain CRLF\r\n[jobs]\r\npreferred_terms = ["analytics, tools"]\r\n';
  const path = `${dir}/judge.toml`;
  await put(root, path, content, 0o644);
  const windows = process.platform === "win32";

  if (windows) setWindowsFixturePublicRead(join(root, path), true);

  const state = await run(loadInitState(root));
  const reviewed = await run(reviewInitPlan(state, { split: { preferred_terms: [windows ? "changed" : "analytics, tools"] } }));
  expect(reviewed.entries).toEqual([{ kind: "file", action: "replace", path: join(dir, "judge.toml") }]);
  expect(await run(reviewed.apply({ ...allow, replace: () => Effect.succeed(false), save: noConsent.save }))).toBe("declined");

  if (windows) {
    await expect(run(reviewed.apply(allow))).rejects.toThrow("Cannot safely access private profile files");
    expect(await get(root, path)).toBe(content);
    expect(await readdir(join(root, dir))).toEqual(["judge.toml", "profile.toml"]);

    return;
  }

  expect((await stat(join(root, path))).mode & 0o777).toBe(0o644);
  expect(await run(reviewed.apply(allow))).toBe("applied");
  expect(await get(root, path)).toBe(content);
  expect((await stat(join(root, path))).mode & 0o777).toBe(0o600);
  const backup = (await readdir(join(root, dir))).find((name) => name.startsWith("judge.toml.bak-"));
  expect(await get(root, `${dir}/${backup}`)).toBe(content);
  expect((await stat(join(root, dir, String(backup)))).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform !== "win32")("unchanged setup refuses an unsafe native ACL without a prompt or backup", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const path = `${dir}/judge.toml`;
  const content = '# Keep these bytes\r\n[jobs]\r\npreferred_terms = ["analytics, tools"]\r\n';
  await put(root, path, content);
  const state = await run(loadInitState(root));
  const reviewed = await run(reviewInitPlan(state, { split: { preferred_terms: ["analytics, tools"] } }));
  expect(reviewed.entries).toEqual([{ kind: "file", action: "unchanged", path: join(dir, "judge.toml") }]);
  setWindowsFixturePublicRead(join(root, path), true);

  await expect(run(reviewed.apply({ ...allow, ...noConsent }))).rejects.toThrow("Cannot safely access private profile files");
  expect(await get(root, path)).toBe(content);
  expect(await readdir(join(root, dir))).toEqual(["judge.toml", "profile.toml"]);
});

test("validates committed models with the accepted decoder and refuses invalid settings without writes", async () => {
  const root = await temporaryRoot();
  await seed(root);
  const invalid = '[screen]\nharness = "pi"\nmodel = "synthetic/fixed"\neffort = "medium"\nbatch_size = 20\n';
  await put(root, models, invalid);
  await expect(run(loadInitState(root))).rejects.toThrow("Existing model settings are invalid. Fix local_only/models.toml first.");
  expect(await get(root, models)).toBe(invalid);
  expect(await readdir(join(root, "local_only"))).toEqual(["models.toml", "profiles"]);
});

test("prevalidates every backup path before checking candidates or writing near a configured store", async () => {
  const root = await temporaryRoot();
  const backupTarget = "filters.toml.bak-20261019T120000000000Z";
  const originalConfig = (await config()).replace('review_db = "review.sqlite3"', `review_db = "${backupTarget}"`);
  const originalFilters = '[jobs]\nexcluded_employers = ["old"]\n';
  await put(root, `${dir}/profile.toml`, originalConfig);
  await put(root, `${dir}/filters.toml`, originalFilters);
  const candidateChecks: string[] = [];

  const attempt = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const guard = FileSystem.FileSystem.of({ ...fs, readLink: (path) => {
      if (path.includes(".bak-")) candidateChecks.push(path);

      return fs.readLink(path);
    } });

    const plan = Effect.gen(function* () {
      const state = yield* loadInitState(root);

      const reviewed = yield* reviewInitPlan(state, {
        profileStep: true, config: originalConfig.replace('mode = "passive"', 'mode = "active"'), split: { excluded_employers: ["new"] },
      });

      return yield* reviewed.apply(allow);
    });

    return yield* plan.pipe(Effect.provide(ProfileFilesLive), Effect.provideService(FileSystem.FileSystem, guard));
  }).pipe(Effect.provide(FixedOsloClock));

  await expect(run(attempt)).rejects.toThrow("Cannot safely keep a private setup backup.");
  expect(candidateChecks).toEqual([]);
  expect((await readdir(join(root, dir))).toSorted()).toEqual(["filters.toml", "profile.toml"]);
  expect(await get(root, `${dir}/profile.toml`)).toBe(originalConfig);
  expect(await get(root, `${dir}/filters.toml`)).toBe(originalFilters);
});
