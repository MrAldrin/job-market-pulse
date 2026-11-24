import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(checkout, "src/cli/pulse.ts");
const app = "job-market-pulse";

const sandbox = (use: (root: string, home: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "pulse-installation-"));
  const home = join(root, "home");
  mkdirSync(home);

  try { use(root, home); } finally { rmSync(root, { recursive: true, force: true }); }
};

const invoke = (args: readonly string[], cwd: string, env: Record<string, string>) => {
  const result = Bun.spawnSync([process.execPath, "--no-env-file", ...args], { cwd, env, timeout: 10_000 });

  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

test("checkout CLI uses its selected root instead of XDG", () => sandbox((root, HOME) => {
  const env = { HOME, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data") };
  const status = invoke([cli, "--root", root, "status"], HOME, env);

  expect(status.stderr).toContain(join(root, "local_only/pulse.toml"));
  expect(existsSync(env.XDG_CONFIG_HOME)).toBe(false);
  expect(existsSync(env.XDG_DATA_HOME)).toBe(false);
}));

test("installed CLI uses separate XDG paths and packaged setup inputs", () => sandbox((root, HOME) => {
  const resources = join(root, "resources");
  const env = { HOME, PULSE_RESOURCE_ROOT: resources, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data") };
  const config = join(env.XDG_CONFIG_HOME, app);
  const data = join(env.XDG_DATA_HOME, app);
  const selector = "local_only/pulse.toml";
  const profile = "local_only/profiles/example";
  const answers = join(root, "answers.toml");
  writeFileSync(answers, 'search_mode = "passive"\n');
  mkdirSync(resources);
  cpSync(join(checkout, "config"), join(resources, "config"), { recursive: true });

  const status = invoke([cli, "status"], root, env);
  const dryRunArgs = [cli, "--profile", "example", "init", "--step", "profile", "--dry-run", "--non-interactive", "--answers", answers];
  const dryRun = invoke(dryRunArgs, root, env);

  expect(status.stderr).toContain(join(config, selector));
  expect(dryRun).toMatchObject({ code: 0, stdout: expect.stringContaining("No files were written") });
  expect(existsSync(config)).toBe(false);
  expect(existsSync(data)).toBe(false);

  // Run the same plan and apply logic as init, with synthetic consent.
  const apply = invoke(["-e", `
    import { readFileSync } from "node:fs";
    import { BunContext } from "@effect/platform-bun";
    import { Effect, Layer } from "effect";
    import { installedPaths } from "./src/lib/server/shared/installation-paths.ts";
    import { ProfileFilesLive } from "./src/lib/server/profile/files.ts";
    import { loadInitState } from "./src/cli/init-state.ts";
    import { reviewInitPlan } from "./src/cli/init-plan.ts";
    await Effect.runPromise(Effect.gen(function* () {
      const state = yield* loadInitState(installedPaths.data, "example");
      const models = readFileSync(installedPaths.resources + "/config/models.example.toml", "utf8");
      const plan = yield* reviewInitPlan(state, { profileStep: true, models });
      const result = yield* plan.apply({ dryRun: false, nonInteractive: false,
        replace: () => Effect.succeed(true), save: () => Effect.succeed(true) });
      console.log(JSON.stringify({ result, database: state.profile.paths.source_db }));
    }).pipe(Effect.provide(ProfileFilesLive.pipe(Layer.provideMerge(BunContext.layer)))));
  `], checkout, env);

  expect(apply).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(apply.stdout)).toEqual({ result: "applied", database: join(data, "data/nav.sqlite3") });
  expect(readFileSync(join(config, selector), "utf8")).toBe('profile = "example"\n');
  expect(existsSync(join(config, "local_only/models.toml"))).toBe(true);
  expect(existsSync(join(data, selector))).toBe(false);
  expect(existsSync(join(resources, "local_only"))).toBe(false);
  expect(readFileSync(join(data, profile, "screen.toml"), "utf8")).toBe(readFileSync(join(resources, "config/title_exclusions.neutral.toml"), "utf8"));
  expect(invoke([cli, "status"], root, env)).toMatchObject({ code: 0, stdout: expect.stringContaining('"profile_id": "example"') });

  const custom = join(root, "custom-checkout");
  mkdirSync(custom);
  expect(invoke([cli, "--root", custom, "status"], root, env).stderr).toContain(join(custom, selector));
}));

test("installed CLI ignores relative XDG bases and refuses a linked config tree", () => sandbox((root, HOME) => {
  const env = { HOME, PULSE_RESOURCE_ROOT: join(root, "resources"), XDG_CONFIG_HOME: "relative", XDG_DATA_HOME: "relative" };
  const config = join(HOME, ".config", app);
  const status = invoke([cli, "status"], root, env);
  const outside = join(root, "outside");
  mkdirSync(join(outside, "local_only"), { recursive: true });
  writeFileSync(join(outside, "local_only/pulse.toml"), 'profile = "elsewhere"\n');
  mkdirSync(join(HOME, ".config"));
  symlinkSync(outside, config);

  expect(status.stderr).toContain(join(config, "local_only/pulse.toml"));
  expect(invoke([cli, "status"], root, env).stderr).toBe(status.stderr);
  expect(existsSync(join(root, "relative"))).toBe(false);
}));

test("installed access rejects linked lock paths, settings, and bundle aliases", () => sandbox((root, HOME) => {
  const resources = join(root, "resources");
  const env = { HOME, PULSE_RESOURCE_ROOT: resources };
  const data = join(HOME, ".local/share", app);
  const settings = join(HOME, ".config", app, "local_only");
  const external = join(root, "outside");
  const lock = ".local-pipeline-installation.lock";
  mkdirSync(data, { recursive: true });
  mkdirSync(join(settings, "config"), { recursive: true });
  mkdirSync(resources);
  mkdirSync(external);
  symlinkSync(external, join(data, "data"));
  symlinkSync(join(checkout, "config/models.example.toml"), join(settings, "models.toml"));
  symlinkSync(join(checkout, "config/market_taxonomy.toml"), join(settings, "config/market_taxonomy.toml"));
  symlinkSync(join(root, "missing.json"), join(settings, "config/interest-patterns.json"));

  const probe = ["-e", `
    import { BunContext } from "@effect/platform-bun";
    import { Effect, Layer } from "effect";
    import { installedPaths } from "./src/lib/server/shared/installation-paths.ts";
    import { withInstallationLock } from "./src/lib/server/orchestration/workflow-locks.ts";
    import { ReviewerSettings, ReviewerSettingsLive } from "./src/lib/server/judge/reviewers.ts";
    import { loadTaxonomy } from "./src/lib/server/market/taxonomy.ts";
    import { loadTitleEvidence } from "./src/lib/server/filter/evidence-pack.ts";
    const root = installedPaths.data;
    await Effect.runPromise(Effect.gen(function* () {
      const models = yield* ReviewerSettings;
      const failures = yield* Effect.forEach([
        withInstallationLock(root, () => Effect.void), models.load(root), loadTaxonomy(root), loadTitleEvidence(root),
      ].map((effect) => Effect.flip(effect)), (effect) => Effect.map(effect, (error) => error._tag));
      console.log(failures.join(","));
    }).pipe(Effect.provide(ReviewerSettingsLive.pipe(Layer.provideMerge(BunContext.layer)))));
  `];

  const expected = { code: 0, stdout: "WorkflowLockError,ReviewerError,MarketError,FilterInputError\n" };

  expect(invoke(probe, checkout, env)).toMatchObject(expected);
  expect(existsSync(join(external, lock))).toBe(false);

  rmSync(join(data, "data"));
  mkdirSync(join(data, "data"));
  symlinkSync(join(external, lock), join(data, "data", lock));

  expect(invoke(probe, checkout, env)).toMatchObject(expected);
  expect(existsSync(join(external, lock))).toBe(false);

  const bundleAlias = join(root, "bundle-alias");
  const args = [cli, "--profile", "example", "status"];
  mkdirSync(join(data, "local_only/profiles/example"), { recursive: true });
  symlinkSync(data, bundleAlias);

  expect(invoke(args, root, env).code).toBe(0);
  expect(invoke(args, root, { ...env, PULSE_RESOURCE_ROOT: bundleAlias })).toMatchObject({
    code: 2, stdout: expect.stringContaining('"status": "blocked"'),
  });
}));
