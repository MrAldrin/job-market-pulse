import { FileSystem } from "@effect/platform";
import { Effect, Predicate } from "effect";
import { realpath } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containsPath, installationSetting } from "../lib/server/shared/installation-paths.ts";
import { isDeepStrictEqual, promisify } from "node:util";
import { TomlDate, type TomlTable } from "smol-toml";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import type { Answers } from "../lib/server/profile/narrative.ts";
import { pythonFloat } from "../lib/server/shared/python-json.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { checkInitPath, createInitParents, initError, initOwnedFiles, initPaths, initSnapshotDigest, initText, isExpectedInitMode, isInitTomlTable, loadInitState, readInitFile, relativeInitPath, rereadInitSelectedFile, type InitState } from "./init-state.ts";

const resumeHint = "Run pulse init normally (without --resume) to start again.";
const answerError = () => initError("Setup answers could not be read as TOML.");
const nativePath = promisify(realpath.native);
const floatAnswers = new Set(["origin_latitude", "origin_longitude", "radius_km"]);
const staleOriginKeys = ["latitude_input", "longitude_input", "home_label", "origin_latitude", "origin_longitude", "origin_source", "area_postcode"];

export interface InitScope {
  readonly step: string | undefined;
  readonly advanced: boolean;
  readonly dryRun: boolean;
}

export interface InitInputRequest extends InitScope {
  readonly root: string;
  readonly profile?: string;
  readonly answersPath?: string;
  readonly resume: boolean;
}

export const initFingerprints = (state: InitState, refresh = false) => Effect.gen(function* () {
  const result: Record<string, string> = {};

  for (const file of Object.values(initOwnedFiles(state))) {
    const key = yield* relativeInitPath(state.root, file.path);
    const original = refresh ? yield* rereadInitSelectedFile(state, file.path) : file.original;
    result[key] = initSnapshotDigest(original);
  }

  return result;
});

const normalizeAnswers = (answers: TomlTable): TomlTable => Object.fromEntries(Object.entries(answers).map(([key, value]) => [
  key, key.startsWith("interview_") && key.endsWith("_followup_index") && Predicate.isBigInt(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value,
]));

const readExplicitAnswers = (root: string, path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const managed = join(root, initPaths.profiles);
  const managedError = () => initError("Use a standalone answers file outside the managed profiles directory.");

  if (containsPath(managed, resolve(path))) return yield* managedError();

  // The platform realPath wrapper can normalize away missing components before '..'.
  const physical = yield* Effect.tryPromise({ try: () => nativePath(path), catch: answerError });

  if (containsPath(managed, physical)) return yield* managedError();

  if (process.platform === "win32") {
    // Use the same native spelling on both sides. The selected root can use an
    // NTFS short name while the resolved file uses the corresponding long name.
    const canonicalManaged = yield* Effect.tryPromise({ try: () => nativePath(managed), catch: (cause) => cause }).pipe(
      Effect.catchAll((cause) => Predicate.isRecord(cause) && cause["code"] === "ENOENT" ? Effect.succeed(null) : Effect.fail(answerError())),
    );

    if (canonicalManaged !== null && containsPath(canonicalManaged, physical)) return yield* managedError();
  }

  return yield* fs.readFile(physical).pipe(
    Effect.mapError(answerError), Effect.flatMap((bytes) => initText({ bytes, mode: 0 })), Effect.flatMap(parseToml), Effect.mapError(answerError),
  );
});

export const prepareInitInputs = (request: InitInputRequest) => Effect.gen(function* () {
  const resources = yield* ProfileFiles;
  const root = yield* resources.root(request.root);
  const saved = installationSetting(root, initPaths.recovery);
  yield* checkInitPath(root, saved, "File");
  let supplied: TomlTable = {};

  if (request.answersPath !== undefined) {
    const document = yield* readExplicitAnswers(root, request.answersPath);
    const wrapped = document.answers ?? document;

    if (!isInitTomlTable(wrapped)) return yield* initError("Explicit answers must be a TOML table.");

    supplied = normalizeAnswers(wrapped);
  }

  const imported = supplied.profile_id;

  if (imported !== undefined && !Predicate.isString(imported)) return yield* initError("Answer profile_id must be text.");

  if (request.profile !== undefined && imported !== undefined && request.profile !== imported) return yield* initError("Conflicting explicit profile IDs.");

  const explicit = request.profile ?? imported;
  let recovered: TomlTable = {};
  let state: InitState;

  if (request.resume) {
    const document = yield* readInitFile(root, saved).pipe(
      Effect.flatMap((snapshot) => snapshot ? initText(snapshot).pipe(Effect.flatMap(parseToml)) : Effect.fail(answerError())),
      Effect.mapError(() => initError("No readable recovery state. " + resumeHint)),
    );

    const { metadata, answers } = document;

    if (!isInitTomlTable(metadata) || !isInitTomlTable(answers)) return yield* initError("Recovery is not versioned setup state. " + resumeHint);

    const identity = metadata.profile_id;

    if (!Predicate.isString(identity) || !identity) return yield* initError("Recovery has no profile identity. " + resumeHint);

    state = yield* loadInitState(root, explicit, identity).pipe(Effect.mapError(() => initError("Recovery inputs are no longer valid. " + resumeHint)));
    const hashes = yield* initFingerprints(state);

    if (metadata.version !== 1n || metadata.status !== "incomplete" || metadata.step !== (request.step ?? "all") ||
      metadata.mode !== (request.advanced ? "advanced" : "quick") || state.profile?.id !== identity ||
      answers.profile_id !== identity || !isInitTomlTable(metadata.fingerprints) || !isDeepStrictEqual({ ...metadata.fingerprints }, hashes)) {
      return yield* initError("Recovery does not match the current setup inputs or scope. " + resumeHint);
    }

    recovered = normalizeAnswers(answers);

    if (Object.hasOwn(supplied, "place_query") && supplied.place_query !== recovered.place_query) {
      recovered = Object.fromEntries(Object.entries(recovered).filter(([key]) => !staleOriginKeys.includes(key)));
    }
  } else {
    state = yield* loadInitState(root, explicit);
  }

  const explicitKeys = new Set(Object.keys(supplied));

  if (request.profile !== undefined) explicitKeys.add("profile_id");

  return { state, answers: { ...recovered, ...supplied }, explicitKeys, recoveredKeys: new Set(Object.keys(recovered)) };
});

const quoted = (text: string) => JSON.stringify(text).replace(/\u007f/g, "\\u007f");

const tomlValue = (value: Answers[string], key = ""): string => {
  if (Predicate.isString(value)) return quoted(value);

  if (Predicate.isBigInt(value) || Predicate.isBoolean(value)) return String(value);

  if (Predicate.isNumber(value)) {
    if (Number.isNaN(value)) return "nan";

    if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";

    return Number.isSafeInteger(value) && !Object.is(value, -0) && !floatAnswers.has(key) ? String(value) : pythonFloat(value);
  }

  if (value instanceof TomlDate) return value.toISOString();

  if (Array.isArray(value)) return "[" + value.map((entry) => tomlValue(entry)).join(", ") + "]";

  if (Predicate.isRecord(value)) return "{ " + Object.entries(value).map(([name, entry]) => `${quoted(name)} = ${tomlValue(entry, name)}`).join(", ") + " }";

  throw initError("Saved answers must contain TOML-compatible values.");
};

const entriesText = (table: Answers) => Object.entries(table).map(([key, value]) => value == null ? "" : `${quoted(key)} = ${tomlValue(value, key)}\n`).join("");

// The controller supplies the interview engine's accepted facts only, never model output or consent.
export const recordInitInterviewFacts = (answers: Answers, facts: Answers): Answers => ({ ...answers, ...facts, interview: "incomplete" });

type CheckpointPhase = "step" | "interview" | "finished";

export const saveInitCheckpoint = (state: InitState, scope: InitScope, answers: Answers, phase: CheckpointPhase) => Effect.gen(function* () {
  if (scope.dryRun) return "dry-run";

  const path = installationSetting(state.root, initPaths.recovery);
  const parent = dirname(path);

  if (phase === "interview" && !(yield* checkInitPath(state.root, parent, "Directory"))) return "memory-only";

  const fingerprints = yield* initFingerprints(state, phase === "finished");
  const profileId = state.profile?.id ?? "";

  const metadata = {
    version: 1n, profile_id: profileId, step: scope.step ?? "all", mode: scope.advanced ? "advanced" : "quick",
    status: phase === "finished" && answers.interview !== "incomplete" ? "completed" : "incomplete", fingerprints,
  };

  const content = yield* Effect.try({
    try: () => "[metadata]\n" + entriesText(metadata) + "\n[answers]\n" + entriesText(answers),
    catch: () => initError("Saved answers must contain TOML-compatible values."),
  });

  yield* parseToml(content);
  const original = yield* readInitFile(state.root, path);
  const files = yield* ProfileFiles;
  const windows = process.platform === "win32";

  if (original !== null && isExpectedInitMode(original.mode) && Buffer.from(original.bytes).equals(Buffer.from(content))) {
    if (windows) yield* files.verifyPrivateFile(state.root, path);

    return "unchanged";
  }

  yield* createInitParents(state.root, parent);
  yield* (original === null ? files.create(state.root, path, content, windows) : files.replace(state.root, path, content, windows));

  return "saved";
});
