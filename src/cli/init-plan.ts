import { FileSystem } from "@effect/platform";
import { Clock, Effect, Predicate } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { TomlTable } from "smol-toml";
import { decodeModelSettings } from "../lib/server/judge/reviewers.ts";
import { replaceModeText } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { decodeFilters, decodeJudge, decodeScreen, mergePreferences } from "../lib/server/profile/settings.ts";
import { bundledResource, installationSetting } from "../lib/server/shared/installation-paths.ts";
import { writeToml } from "../lib/server/shared/toml.ts";
import type { InterviewFilePlan } from "./interview-step.ts";
import { checkInitPath, createInitParents, initError, initOwnedFiles, initPaths, initProfilePaths, initSnapshotDigest, initText, isInitTomlTable, pathsOverlap, relativeInitPath, rereadInitSelectedFile, type InitFileSnapshot, type InitOwnedFile, type InitProfile, type InitSelectedSnapshot, type InitState } from "./init-state.ts";

export const planInitProfileMode = (profile: InitProfile, mode: "passive" | "active") => replaceModeText(profile.configText, mode);

const geographyKeys = ["origin_latitude", "origin_longitude", "origin_source", "radius_km", "home_label", "area_postcode"] as const;
const filterJobKeys = ["allowed_occupation_categories", "excluded_title_terms", "excluded_employers"] as const;
const judgeJobKeys = ["preferred_terms"] as const;

export interface InitSplitEdits {
  readonly origin_latitude?: number;
  readonly origin_longitude?: number;
  readonly origin_source?: string;
  readonly radius_km?: number | bigint;
  readonly home_label?: string;
  readonly area_postcode?: string;
  readonly allowed_occupation_categories?: readonly string[];
  readonly excluded_title_terms?: readonly string[];
  readonly excluded_employers?: readonly string[];
  readonly preferred_terms?: readonly string[];
}

export interface InitPlanEdits {
  /** Final config text, including any schedule changes composed on top of mode. */
  readonly config?: string | undefined;
  readonly profileStep?: boolean;
  readonly models?: string | undefined;
  readonly narrative?: InterviewFilePlan | undefined;
  /** Include only selected edits, not defaults from unvisited steps. */
  readonly split?: InitSplitEdits | undefined;
}

const updateTable = (document: TomlTable, section: string, keys: readonly (keyof InitSplitEdits)[], edits: InitSplitEdits, defaults: TomlTable = {}) => Effect.gen(function* () {
  const original = document[section];

  if (original !== undefined && !isInitTomlTable(original)) return yield* initError("Existing split settings have an invalid table.");

  const updated: TomlTable = { ...defaults, ...original };

  for (const key of keys) {
    const value = edits[key];

    if (value === undefined) continue;

    if (key === "area_postcode" && value === "") delete updated[key];
    else updated[key] = Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBigInt(value) ? value : [...value];
  }

  if (isDeepStrictEqual(Object.entries(original ?? {}), Object.entries(updated))) return document;

  return { ...document, [section]: updated };
});

const splitText = (file: InitOwnedFile, before: TomlTable, after: TomlTable) => file.original !== null && isDeepStrictEqual(before, after)
  ? initText(file.original)
  : writeToml(after);

const neutralScreen = bundledResource(fileURLToPath(new URL("../../", import.meta.url)), "config/title_exclusions.neutral.toml");

const loadNeutralScreen = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(neutralScreen).pipe(Effect.mapError(() => initError("Cannot read the tracked neutral Screen rules.")));
  const text = yield* initText({ bytes, mode: 0 });
  yield* decodeScreen(text);

  return text;
});

interface PlannedFile extends InitOwnedFile {
  readonly content: string;
  readonly overwrite: boolean;
}

interface PlannedDirectory {
  readonly path: string;
  readonly exists: boolean;
}

const sameSnapshot = (original: InitSelectedSnapshot | null, current: InitSelectedSnapshot | null): boolean => {
  if (original === null || current === null) return original === current;

  if (original.mode !== current.mode) return false;

  if ("bytes" in original && "bytes" in current) return Buffer.from(original.bytes).equals(current.bytes);

  return !("bytes" in original) && !("bytes" in current) && original.digest === current.digest;
};

const changedDestination = () => initError("A planned destination changed during confirmation. Run setup again.");

const verifyBaselines = (state: InitState) => Effect.gen(function* () {
  for (const file of Object.values(initOwnedFiles(state))) {
    const current = yield* rereadInitSelectedFile(state, file.path);

    if (!sameSnapshot(file.original, current)) return yield* changedDestination();
  }

  const profile = state.profile;

  if (profile !== null) {
    const exists = yield* checkInitPath(state.root, profile.paths.directory, "Directory");
    const outbox = yield* checkInitPath(state.root, profile.paths.outbox_dir, "Directory");

    if (profile.exists !== exists || profile.outboxExists !== outbox) return yield* changedDestination();
  }

  if (!profile?.exists || state.createSelector) {
    const fs = yield* FileSystem.FileSystem;
    const parent = join(state.root, initPaths.profiles);

    const ids = (yield* checkInitPath(state.root, parent, "Directory"))
      ? yield* fs.readDirectory(parent).pipe(Effect.mapError(changedDestination)) : [];

    if (!isDeepStrictEqual(ids.toSorted(), state.ids)) return yield* changedDestination();
  }
});

const fileAction = (file: PlannedFile) => file.original === null ? "new"
  : file.original.mode === 0o600 && Buffer.from(file.content).equals(file.original.bytes) ? "unchanged" : "replace";

export interface InitPlanEntry {
  readonly kind: "file" | "directory";
  readonly action: "new" | "unchanged" | "replace";
  readonly path: string;
}

interface InitConsent<R, E> {
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly replace: (relativePath: string) => Effect.Effect<boolean, E, R>;
  readonly save: () => Effect.Effect<boolean, E, R>;
}

const backupError = () => initError("Cannot safely keep a private setup backup.");

const prepareBackups = (state: InitState, plan: readonly (PlannedFile | PlannedDirectory)[]) => Effect.gen(function* () {
  const protectedPaths = [installationSetting(state.root, initPaths.recovery), ...Object.values(initOwnedFiles(state)).map((file) => file.path), ...plan.map((item) => item.path)];
  const paths = state.profile?.paths;

  if (paths) protectedPaths.push(paths.source_db, paths.review_db, paths.ledger_db, paths.outbox_dir, paths.preferences_file, join(paths.directory, "preferences.toml"));

  const now = yield* Clock.currentTimeMillis;
  const stamp = new Date(now).toISOString().replace(/[-:.Z]/g, "") + "000Z";
  const backups = new Map<PlannedFile, string>();

  for (const item of plan) {
    if (!("content" in item) || fileAction(item) !== "replace") continue;

    const path = `${item.path}.bak-${stamp}`;

    if (protectedPaths.some((other) => pathsOverlap(path, other))) return yield* backupError();

    protectedPaths.push(path);
    backups.set(item, path);
  }

  for (const path of backups.values()) {
    if (yield* checkInitPath(state.root, path, "File")) return yield* backupError();
  }

  return backups;
});

const writeBackup = (root: string, path: string, original: InitFileSnapshot) => Effect.gen(function* () {
  if (yield* checkInitPath(root, path, "File")) return yield* backupError();

  const fs = yield* FileSystem.FileSystem;
  yield* Effect.gen(function* () {
    const temporary = yield* fs.makeTempFileScoped({ directory: dirname(path), prefix: ".init-backup-" });
    yield* fs.chmod(temporary, 0o600);
    const file = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
    yield* file.writeAll(original.bytes);
    yield* file.sync;
    yield* fs.link(temporary, path);
  }).pipe(Effect.scoped, Effect.mapError(backupError));
});

export const reviewInitPlan = (state: InitState, edits: InitPlanEdits) => Effect.gen(function* () {
  const plan: (PlannedFile | PlannedDirectory)[] = [];
  const profile = state.profile;
  const profileEdited = edits.profileStep || edits.config !== undefined || edits.narrative !== undefined || edits.split !== undefined;

  if (profileEdited && !profile) return yield* initError("Run the profile step first.");

  if (profile && !profile.exists && !edits.profileStep && (profileEdited || edits.models !== undefined)) return yield* initError("Run the profile step first.");

  if (profile && (edits.profileStep || edits.config !== undefined)) {
    const content = edits.config ?? profile.configText;
    const paths = yield* initProfilePaths(state.root, profile.id, content);

    if (!isDeepStrictEqual(paths, profile.paths)) return yield* initError("Setup does not change configured storage paths.");

    plan.push({ ...profile.files.config, content, overwrite: profile.exists });
  }

  if (profile && edits.profileStep) {
    plan.push({ path: profile.paths.outbox_dir, exists: profile.outboxExists });

    if (state.createSelector) plan.push({ ...state.files.selector, content: `profile = ${JSON.stringify(profile.id)}\n`, overwrite: false });
  }

  if (edits.models !== undefined) {
    yield* decodeModelSettings(edits.models);
    plan.push({ ...state.files.models, content: edits.models, overwrite: true });
  }

  if (profile && (edits.split !== undefined || (!profile.exists && edits.profileStep))) {
    const changes = edits.split ?? {};
    const geography = yield* updateTable(profile.filters, "geography", geographyKeys, changes);
    const filters = yield* updateTable(geography, "jobs", filterJobKeys, changes, profile.exists ? {} : { allowed_occupation_categories: [] });
    const judge = yield* updateTable(profile.judge, "jobs", judgeJobKeys, changes, profile.exists ? {} : { preferred_terms: [] });

    const filtersText = yield* splitText(profile.files.filters, profile.filters, filters);
    const judgeText = yield* splitText(profile.files.judge, profile.judge, judge);
    const ownedFilters = yield* decodeFilters(filtersText);
    const ownedJudge = yield* decodeJudge(judgeText);
    yield* mergePreferences(ownedFilters, ownedJudge);

    if (profile.files.filters.original !== null || Object.keys(filters).length > 0) {
      plan.push({ ...profile.files.filters, content: filtersText, overwrite: profile.exists });
    }

    if (profile.files.judge.original !== null || Object.keys(judge).length > 0) {
      plan.push({ ...profile.files.judge, content: judgeText, overwrite: profile.exists });
    }
  }

  if (profile && !profile.exists && edits.profileStep) {
    plan.push({ ...profile.files.screen, content: yield* loadNeutralScreen, overwrite: false });
  }

  if (profile && edits.narrative) {
    const { path, original } = profile.files.narrative;

    if (original !== null && !("bytes" in original)) return yield* initError("The existing profile text is too large to replace or back up during setup.");

    if (edits.narrative.path !== (yield* relativeInitPath(state.root, path)) || edits.narrative.expectedDigest !== initSnapshotDigest(original)) {
      return yield* initError("The profile text changed during the interview. Run setup again.");
    }

    plan.push({ path, original, content: edits.narrative.content, overwrite: edits.narrative.overwrite });
  }

  yield* verifyBaselines(state);
  const entries: InitPlanEntry[] = [];
  const replacements: string[] = [];

  for (const item of plan) {
    const path = yield* relativeInitPath(state.root, item.path);

    if (!("content" in item)) {
      entries.push({ kind: "directory", action: item.exists ? "unchanged" : "new", path });
      continue;
    }

    const action = fileAction(item);

    if (action === "replace") {
      if (!item.overwrite) return yield* initError("An existing file is protected from overwrite.");

      replacements.push(path);
    }

    entries.push({ kind: "file", action, path });
  }

  const apply = <R, E>(consent: InitConsent<R, E>) => Effect.gen(function* () {
    if (consent.dryRun) return "dry-run";

    if (entries.every((entry) => entry.action === "unchanged")) return "unchanged";

    if (consent.nonInteractive) return "needs-terminal";

    for (const path of replacements) {
      if (!(yield* consent.replace(path))) return "declined";
    }

    if (!(yield* consent.save())) return "declined";

    // No settings (including backups or directories) are touched until every baseline passes.
    const backups = yield* prepareBackups(state, plan);
    yield* verifyBaselines(state);
    const resources = yield* ProfileFiles;

    for (const file of plan) {
      if (!("content" in file)) {
        yield* createInitParents(state.root, file.path);
        continue;
      }

      if (fileAction(file) === "unchanged") continue;

      const current = yield* rereadInitSelectedFile(state, file.path);

      if (!sameSnapshot(file.original, current)) return yield* changedDestination();

      yield* createInitParents(state.root, dirname(file.path));

      if (file.original === null) yield* resources.create(state.root, file.path, file.content);
      else {
        const backup = backups.get(file);

        if (backup === undefined) return yield* backupError();

        yield* writeBackup(state.root, backup, file.original);
        yield* resources.replace(state.root, file.path, file.content);
      }
    }

    return "applied";
  });

  const reviewedEntries: readonly InitPlanEntry[] = entries;

  return { entries: reviewedEntries, apply };
});
