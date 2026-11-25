import { FileSystem } from "@effect/platform";
import { Effect, Predicate, Stream } from "effect";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import { decodeModelSettings } from "../lib/server/judge/reviewers.ts";
import { decodeProfileId, decodeProfileSettings, initialProfileConfig, parseCadence, pathsFor } from "../lib/server/profile/core.ts";
import { ProfileError } from "../lib/server/profile/errors.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { installationSetting, installedPaths, storageAnchor } from "../lib/server/shared/installation-paths.ts";
import { sha256 } from "../lib/server/shared/python-json.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { maxInterviewContextBytes } from "./interview-session.ts";

export const initError = (message: string) => new ProfileError({ message });
const accessError = () => initError("Setup could not continue safely. Check local file access.");
const selectionHint = "Select an existing profile with pulse --profile ID init.";

export const initPaths = {
  selector: "local_only/pulse.toml", models: "local_only/models.toml",
  recovery: "local_only/init-answers.toml", profiles: "local_only/profiles",
} as const;

export const relativeInitPath = (root: string, path: string) => Effect.gen(function* () {
  const name = relative(storageAnchor(root, path), path);

  if (!name || isAbsolute(name) || name.split(sep).some((part) => ["..", ".git", ".jj"].includes(part))) {
    return yield* initError("A planned path is unsafe or outside the installation.");
  }

  return name;
});

export const checkInitPath = (root: string, path: string, kind: "File" | "Directory") => Effect.gen(function* () {
  yield* relativeInitPath(root, path);

  return yield* (yield* ProfileFiles).check(root, path, kind);
});

// Windows mode bits describe the read-only attribute, not the NTFS ACL.
export const isExpectedInitMode = (mode: number): boolean => process.platform === "win32" ? (mode & 0o200) !== 0 : mode === 0o600;

export interface InitFileSnapshot {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export const readInitFile = (root: string, path: string) => Effect.gen(function* () {
  if (!(yield* checkInitPath(root, path, "File"))) return null;

  const fs = yield* FileSystem.FileSystem;
  const { mode } = yield* fs.stat(path).pipe(Effect.mapError(accessError));
  const bytes = yield* fs.readFile(path).pipe(Effect.mapError(accessError));

  return { bytes, mode: mode & 0o7777 } satisfies InitFileSnapshot;
});

export interface InitOversizeNarrative {
  readonly mode: number;
  readonly digest: string;
}

export type InitSelectedSnapshot = InitFileSnapshot | InitOversizeNarrative;

const readInitNarrative = (root: string, path: string): Effect.Effect<InitSelectedSnapshot | null, ProfileError, FileSystem.FileSystem | ProfileFiles> => Effect.gen(function* () {
  if (!(yield* checkInitPath(root, path, "File"))) return null;

  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(path).pipe(Effect.mapError(accessError));
  const mode = stat.mode & 0o7777;
  const hash = createHash("sha256");
  const buffer = new Uint8Array(maxInterviewContextBytes);
  let length = 0;
  let oversize = false;

  // Full identity, bounded memory. An oversize result exposes no partial bytes.
  yield* Stream.runForEach(fs.stream(path, { chunkSize: 16 * 1024 }), (chunk) => Effect.sync(() => {
    hash.update(chunk);

    if (oversize || length + chunk.byteLength > buffer.byteLength) {
      oversize = true;

      return;
    }

    buffer.set(chunk, length);
    length += chunk.byteLength;
  })).pipe(Effect.mapError(accessError));

  return oversize ? { mode, digest: hash.digest("hex") } : { mode, bytes: buffer.subarray(0, length) };
});

export const initSnapshotDigest = (snapshot: InitSelectedSnapshot | null): string => {
  if (snapshot === null) return "missing";

  return "bytes" in snapshot ? sha256(snapshot.bytes) : snapshot.digest;
};

export const initText = (original: InitFileSnapshot) => Effect.try({
  try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes),
  catch: accessError,
});

export const isInitTomlTable = (value: TomlValue | undefined): value is TomlTable => Predicate.isRecord(value) && !(value instanceof TomlDate);

const table = (snapshot: InitFileSnapshot | null) => snapshot === null
  ? Effect.succeed<TomlTable>({})
  : initText(snapshot).pipe(Effect.flatMap(parseToml));

export type InitFileKey = "selector" | "models" | "config" | "narrative" | "filters" | "judge" | "screen";

export interface InitOwnedFile<Snapshot extends InitSelectedSnapshot = InitFileSnapshot> {
  readonly path: string;
  readonly original: Snapshot | null;
}

const ownedFile = (root: string, path: string) => readInitFile(root, path).pipe(Effect.map((original): InitOwnedFile => ({ path, original })));

const within = (parent: string, path: string): boolean => {
  const remainder = relative(parent, path);

  return !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(".." + sep);
};

export const pathsOverlap = (left: string, right: string): boolean => within(left, right) || within(right, left);

export const selectedInitProfile = (root: string, id: string, text: string) => Effect.gen(function* () {
  const config = yield* decodeProfileSettings(text);

  if (config.profile.id !== id) return yield* initError("Profile ID does not match its directory.");

  const cadence = yield* parseCadence(config.policy);
  const paths = yield* pathsFor(root, id, config);

  // Compatibility paths are metadata only, even when a malformed config aliases split settings.
  const legacy = [paths.preferences_file, join(paths.directory, "preferences.toml")];
  const active = [paths.profile_file, paths.narrative_file, paths.outbox_dir, ...["filters.toml", "judge.toml", "screen.toml"].map((name) => join(paths.directory, name))];

  if (active.some((path) => legacy.some((retired) => pathsOverlap(path, retired)))) {
    return yield* initError("A setup path overlaps retired preferences storage.");
  }

  // Only setup-owned files and its outbox directory are checked. Store paths are metadata.
  for (const path of [paths.narrative_file, paths.outbox_dir]) {
    yield* relativeInitPath(root, path);
  }

  return { config, paths, cadence };
});

export const initProfilePaths = (root: string, id: string, text: string) =>
  selectedInitProfile(root, id, text).pipe(Effect.map(({ paths }) => paths));

export const freshInitConfig = (id: string) => initialProfileConfig(id).pipe(
  Effect.map((text) => text.replace('source_db = "data/REPLACE_WITH_SHARED_FEED.sqlite3"', 'source_db = "data/nav.sqlite3"')),
);

const inspectSelection = (root: string) => Effect.gen(function* () {
  const parent = join(root, initPaths.profiles);
  const fs = yield* FileSystem.FileSystem;
  const ids = (yield* checkInitPath(root, parent, "Directory")) ? yield* fs.readDirectory(parent).pipe(Effect.mapError(accessError)) : [];
  const selector = yield* ownedFile(root, installationSetting(root, initPaths.selector));

  return { ids: ids.toSorted(), selector };
});

const readProfile = (root: string, id: string, exists: boolean) => Effect.gen(function* () {
  yield* decodeProfileId(id);
  const directory = join(root, initPaths.profiles, id);
  const present = yield* checkInitPath(root, directory, "Directory");

  if (present !== exists) return yield* initError("The selected profile changed. Run setup again.");

  const config = yield* ownedFile(root, join(directory, "profile.toml"));

  if (exists !== (config.original !== null)) return yield* initError("The selected profile configuration is missing or changed.");

  const configText = yield* (config.original ? initText(config.original) : freshInitConfig(id));
  const paths = yield* initProfilePaths(root, id, configText);
  const narrative = { path: paths.narrative_file, original: yield* readInitNarrative(root, paths.narrative_file) };
  const filters = yield* ownedFile(root, join(directory, "filters.toml"));
  const judge = yield* ownedFile(root, join(directory, "judge.toml"));
  const screen = yield* ownedFile(root, join(directory, "screen.toml"));
  const outboxExists = yield* checkInitPath(root, paths.outbox_dir, "Directory");

  return {
    id, exists, paths, outboxExists, configText, files: { config, narrative, filters, judge, screen },
    config: yield* parseToml(configText), filters: yield* table(filters.original), judge: yield* table(judge.original),
  };
});

export type InitProfile = Effect.Effect.Success<ReturnType<typeof readProfile>>;

export interface InitState {
  readonly root: string;
  readonly explicit: string | undefined;
  readonly profile: InitProfile | null;
  readonly ids: readonly string[];
  readonly createSelector: boolean;
  readonly files: Readonly<Record<"selector" | "models", InitOwnedFile>>;
  readonly models: TomlTable;
}

export const loadInitState = (rawRoot: string, explicit?: string, firstRunRecoveryId?: string) => Effect.gen(function* () {
  const resources = yield* ProfileFiles;
  const root = yield* resources.root(rawRoot);
  const { ids, selector } = yield* inspectSelection(root);
  const createSelector = selector.original === null && ids.length <= 1;
  let selected = explicit ?? (selector.original === null && ids.length === 0 ? firstRunRecoveryId : undefined);

  if (selected !== undefined) {
    yield* decodeProfileId(selected);

    if (ids.length > 0 && !ids.includes(selected)) return yield* initError("Creating another profile is not supported. " + selectionHint);
  } else if (selector.original !== null) {
    const document = yield* table(selector.original).pipe(Effect.mapError(() => initError("Saved profile selection is invalid. " + selectionHint)));
    const id = document.profile;

    if (!Predicate.isString(id) || Object.keys(document).length !== 1) return yield* initError("Saved profile selection is invalid. " + selectionHint);

    yield* decodeProfileId(id).pipe(Effect.mapError(() => initError("Saved profile selection is invalid. " + selectionHint)));

    if (!ids.includes(id)) return yield* initError("Saved profile selection is missing. " + selectionHint);

    selected = id;
  } else if (ids.length > 1) {
    return yield* initError("Profile selection is ambiguous. " + selectionHint);
  } else {
    selected = ids[0];
  }

  const profile = selected === undefined ? null : yield* readProfile(root, selected, ids.includes(selected));
  const models = yield* ownedFile(root, installationSetting(root, initPaths.models));

  const invalidModels = () => initError("Existing model settings are invalid. Fix local_only/models.toml first.");

  const modelTable = models.original === null ? {} : yield* initText(models.original).pipe(
    Effect.tap(decodeModelSettings), Effect.flatMap(parseToml), Effect.mapError(invalidModels),
  );

  return {
    root, explicit: explicit ?? (profile?.exists === false ? profile.id : undefined), profile, ids, createSelector,
    files: { selector, models },
    models: modelTable,
  } satisfies InitState;
});

export const bindInitProfile = (state: InitState, id: string) => Effect.gen(function* () {
  if (state.profile?.id === id) return { ...state, profile: state.profile };

  if (state.profile !== null || state.ids.length > 0) return yield* initError("The selected profile cannot be changed during setup.");

  return { ...state, explicit: id, profile: yield* readProfile(state.root, id, false) };
});

export const initOwnedFiles = (state: InitState): Partial<Record<InitFileKey, InitOwnedFile<InitSelectedSnapshot>>> => ({ ...state.files, ...state.profile?.files });

export const rereadInitSelectedFile = (state: InitState, path: string) => state.profile?.files.narrative.path === path
  ? readInitNarrative(state.root, path) : readInitFile(state.root, path);

export const createInitParents = (root: string, directory: string) => Effect.gen(function* () {
  const anchor = storageAnchor(root, directory);
  const files = yield* ProfileFiles;

  if (root === installedPaths?.data) yield* files.directory(root, anchor);

  if (directory === anchor) return;
  const name = yield* relativeInitPath(root, directory);
  let current = anchor;

  for (const part of name.split(sep)) {
    current = join(current, part);
    yield* files.directory(root, current);
  }
});
