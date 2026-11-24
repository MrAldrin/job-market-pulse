import type { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { dirname, join } from "node:path";
import { installationSetting } from "../lib/server/shared/installation-paths.ts";
import type { TomlTable } from "smol-toml";
import { FiltersSettings, JudgeSettings } from "../lib/contracts/profile-settings.ts";
import { decodeStrict } from "../lib/contracts/support.ts";
import { decodeModelSettings, modelSettingsFile } from "../lib/server/judge/reviewers.ts";
import { dateToken, decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { checkNarrative } from "../lib/server/profile/narrative.ts";
import { validateSchedule } from "../lib/server/profile/schedule-period.ts";
import { decodeFilters, decodeJudge, decodeScreen, mergePreferences } from "../lib/server/profile/settings.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { databasePathState } from "./doctor-host.ts";
import { checkInitPath, isInitTomlTable, selectedInitProfile } from "./init-state.ts";
import type { ProfileCheckCode, ProfileFindings } from "./profile-check-output.ts";

const messages = {
  profile_dir: ["Profile directory exists.", "Run pulse init with the intended profile ID."],
  profile_toml: ["Profile policy TOML is readable.", "Create or correct the profile's profile.toml file."],
  narrative: ["Profile text has enough content.", "Add meaningful personal evidence and correct the reported privacy or content problem."],
  preferences: ["Preferences are readable and valid.", "Correct the profile's filters.toml, judge.toml or screen.toml file."],
  origin: ["An explicit origin is set.", "Set origin_latitude, origin_longitude and origin_source in filters.toml."],
  radius: ["An explicit radius is set.", "Set radius_km in filters.toml."],
  occupations: ["Allowed occupation categories are set.", "Set nonempty allowed_occupation_categories in filters.toml and preferred_terms in judge.toml."],
  source_db: ["The configured source database exists.", "Check paths.source_db in profile.toml. Use a regular file or a path that does not exist yet, inside the installation."],
  reviewer: ["Installation model settings are valid.", "Create or correct local_only/models.toml using config/models.example.toml."],
  outbox: ["The outbox directory exists.", "Create the directory set by paths.outbox in profile.toml."],
} as const satisfies Record<ProfileCheckCode, readonly [string, string]>;

const finding = (key: ProfileCheckCode, ok: boolean, problem = "Setup is missing or invalid.") => ({
  ok, message: ok ? messages[key][0] : problem, fix: messages[key][1],
});

const readTable = (text: string | null): TomlTable => text === null ? {} : Either.getOrElse(parseToml(text), () => ({}));
const table = (raw: TomlTable, key: string): TomlTable => isInitTomlTable(raw[key]) ? raw[key] : {};

const pick = (raw: TomlTable, keys: readonly string[]): TomlTable => Object.fromEntries(keys.flatMap((key) => {
  const value = raw[key];

  return value === undefined ? [] : [[key, value]];
}));

const filterFields = decodeStrict(FiltersSettings);
const judgeFields = decodeStrict(JudgeSettings);

// Decode the relevant fields independently: a bad radius must not hide a valid origin.
const splitFindings = (filtersText: string | null, judgeText: string | null, screenText: string | null) => {
  const rawFilters = readTable(filtersText);
  const geography = table(rawFilters, "geography");
  const originKeys = ["origin_latitude", "origin_longitude", "origin_source"];
  const origin = originKeys.every((key) => geography[key] !== undefined) && Either.isRight(filterFields({ geography: pick(geography, originKeys) }));
  const radius = geography.radius_km !== undefined && Either.isRight(filterFields({ geography: pick(geography, ["radius_km"]) }));
  const admission = filterFields({ jobs: pick(table(rawFilters, "jobs"), ["allowed_occupation_categories"]) });
  const preferred = judgeFields({ jobs: pick(table(readTable(judgeText), "jobs"), ["preferred_terms"]) });

  const occupations = Either.isRight(admission) && (admission.right.jobs?.allowed_occupation_categories?.length ?? 0) > 0
    && Either.isRight(preferred) && preferred.right.jobs?.preferred_terms !== undefined;

  const preferences = filtersText !== null && judgeText !== null && screenText !== null && Either.isRight(Either.gen(function* () {
    yield* decodeScreen(screenText);

    return yield* mergePreferences(yield* decodeFilters(filtersText), yield* decodeJudge(judgeText));
  }));

  return { preferences, origin, radius, occupations };
};

const checkedPaths = (root: string, id: string, text: string) => Effect.gen(function* () {
  const { config, paths, cadence } = yield* selectedInitProfile(root, id, text);

  if (config.schedule !== undefined) {
    const schedule = config.schedule.anchor === undefined ? config.schedule : { ...config.schedule, anchor: dateToken(config.schedule.anchor) };
    yield* validateSchedule(schedule, cadence.kind === "weekly" ? "weekly" : "every 2 weeks");
  }

  return paths;
});

export const readProfileModels = (root: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;

  return yield* files.read(root, installationSetting(root, modelSettingsFile)).pipe(
    Effect.flatMap(decodeModelSettings), Effect.orElseSucceed(() => null),
  );
});

// Share guarded policy and model reads with doctor; neither this collector nor
// standalone Profile check opens a database or looks up an executable.
export const collectProfileEvidence = (root: string | null, id: string, exists: boolean) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const directory = root === null ? null : join(root, "local_only", "profiles", id);
  const read = (path: string) => root === null ? Effect.succeed(null) : files.read(root, path).pipe(Effect.orElseSucceed(() => null));
  const config = exists && directory !== null ? yield* read(join(directory, "profile.toml")) : null;
  const paths = root !== null && config !== null ? yield* checkedPaths(root, id, config).pipe(Effect.orElseSucceed(() => null)) : null;
  const narrative = paths === null ? null : yield* read(paths.narrative_file);
  const narrativeProblem = narrative === null ? "Profile text cannot be read." : checkNarrative(narrative, { requireTemplate: false })[0];
  const readSplit = (name: string) => paths === null ? Effect.succeed(null) : read(join(paths.directory, name));
  const split = splitFindings(yield* readSplit("filters.toml"), yield* readSplit("judge.toml"), yield* readSplit("screen.toml"));
  const check = (path: string, kind: "File" | "Directory") => root === null ? Effect.succeed(false) : checkInitPath(root, path, kind).pipe(Effect.orElseSucceed(() => false));
  const models = root === null ? null : yield* readProfileModels(root);
  const problem = root === null ? "Setup is missing or unsafe." : undefined;

  const sourceState = root === null || paths === null ? "invalid" : yield* databasePathState(root, paths.source_db);
  const sourceParent = paths === null ? null : dirname(paths.source_db);

  // The refresh lock creates data/, not other configured Source directories.
  const missingSourceParent = sourceState === "pending" && root !== null && sourceParent !== null
    && sourceParent !== root && sourceParent !== join(root, "data") && !(yield* check(sourceParent, "Directory"));

  const findings: ProfileFindings = {
    profile_dir: finding("profile_dir", exists, problem),
    profile_toml: finding("profile_toml", paths !== null, problem),
    narrative: finding("narrative", narrativeProblem === undefined, problem ?? narrativeProblem),
    preferences: finding("preferences", split.preferences, problem),
    origin: finding("origin", split.origin, problem),
    radius: finding("radius", split.radius, problem),
    occupations: finding("occupations", split.occupations, problem),
    source_db: sourceState === "pending"
      ? {
        ok: !missingSourceParent, pending: true,
        message: missingSourceParent ? "The Source database directory does not exist." : "The first refresh creates the Source database.",
        fix: missingSourceParent ? "Create the parent directory of paths.source_db in profile.toml before refresh." : "",
      }
      : finding("source_db", sourceState === "present", "The configured Source database path could not be checked."),
    reviewer: finding("reviewer", models !== null, problem),
    outbox: finding("outbox", paths !== null && (yield* check(paths.outbox_dir, "Directory")), problem),
  };

  return { findings, models, paths };
});

export const collectProfileFindings = (rawRoot: string, id: string): Effect.Effect<ProfileFindings, never, ProfileFiles | FileSystem.FileSystem> => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const root = Either.isRight(decodeProfileId(id)) ? yield* files.root(rawRoot).pipe(Effect.orElseSucceed(() => null)) : null;
  const exists = root !== null && (yield* files.check(root, join(root, "local_only", "profiles", id), "Directory").pipe(Effect.orElseSucceed(() => false)));

  return (yield* collectProfileEvidence(root, id, exists)).findings;
});
