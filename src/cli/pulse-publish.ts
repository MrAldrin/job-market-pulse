import { Command, CommandExecutor, FileSystem, Terminal } from "@effect/platform";
import { Console, Data, Effect, Either, Predicate } from "effect";
import { isAbsolute, join, resolve } from "node:path";
import type { TomlTable } from "smol-toml";
import { decodeSnapshotDocumentBytes } from "../lib/contracts/snapshot.ts";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { installationSetting } from "../lib/server/shared/installation-paths.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { exportLatestSnapshot } from "../lib/server/snapshot/export-latest.ts";
import { SnapshotStore } from "../lib/server/snapshot/store.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { withInstallationLock } from "../lib/server/orchestration/workflow-locks.ts";

export class PublishError extends Data.TaggedError("PublishError")<{ readonly message: string }> {}

interface UploadOverrides {
  readonly service?: string | undefined;
  readonly volume?: string | undefined;
}

const invalid = () => new PublishError({ message: "Cannot use local_only/publish.toml for the selected profile." });

const validName = (value: unknown): value is string => Predicate.isString(value) && value.trim().length > 0
  && Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

const isRailwayId = (value: TomlTable[string] | undefined): value is string => Predicate.isString(value) && value.length === 36
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);

const readPublishConfig = (root: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const path = installationSetting(root, "local_only/publish.toml");

  return (yield* files.check(root, path, "File")) ? yield* Effect.flatMap(files.read(root, path), parseToml) : null;
}).pipe(Effect.mapError(invalid));

const validatePublishSettings = (root: string, id: string, config: TomlTable, overrides: UploadOverrides) => Effect.gen(function* () {
  const files = yield* ProfileFiles;

  if (config.profile !== undefined && config.profile !== id) return yield* invalid();

  if (config.profile_root !== undefined) {
    if (!Predicate.isString(config.profile_root)) return yield* invalid();
    const configuredRoot = config.profile_root.startsWith("~") ? config.profile_root : resolve(root, config.profile_root);

    if ((yield* files.root(configuredRoot)) !== root) return yield* invalid();
  }

  const service = overrides.service ?? config.service ?? "digest-view";
  const volume = overrides.volume ?? config.volume;
  const origin = config.public_url;
  const allowPrivateInputs = config.allow_private_inputs;

  if (!validName(service) || (volume !== undefined && !validName(volume)) || (origin !== undefined && !Predicate.isString(origin))
    || (allowPrivateInputs !== undefined && !Predicate.isBoolean(allowPrivateInputs))
    || (allowPrivateInputs === true && config.profile !== id)) return yield* invalid();

  const { project, environment } = config;

  const privateDestination = allowPrivateInputs === true && isRailwayId(project) && isRailwayId(environment)
    && isRailwayId(config.service) && isRailwayId(config.volume) && service === config.service && volume === config.volume
    ? { project, environment, service, volume } : null;

  return { service, volume, origin, privateDestination };
}).pipe(Effect.mapError(invalid));

export type PublishSettings = Effect.Effect.Success<ReturnType<typeof validatePublishSettings>>;

// Only an explicit publish command may use the linked-project defaults without a settings file.
const publishSettings = (root: string, id: string, overrides: UploadOverrides) => readPublishConfig(root).pipe(
  Effect.flatMap((config) => validatePublishSettings(root, id, config ?? {}, overrides)),
);

export const refreshPublishSettings = (root: string, id: string, scheduled: boolean, overrides: UploadOverrides = {}) => Effect.gen(function* () {
  const config = yield* readPublishConfig(root);

  if (config === null) return null;
  const target = yield* validatePublishSettings(root, id, config, overrides);

  return scheduled && target.volume === undefined ? null : target;
});

export const selectedSnapshot = (root: string, id: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const store = yield* SnapshotStore;
  const snapshot = join(root, "local_only", "profiles", id, "dashboard-snapshot.sqlite3");
  yield* files.check(root, snapshot, "File");

  if ((yield* store.readProfile(snapshot, id)) === null) return yield* new PublishError({ message: "The selected profile has no saved snapshot." });

  return snapshot;
}).pipe(Effect.catchAll(() => Effect.fail(new PublishError({ message: "No valid saved snapshot for the selected profile." }))));

interface PreparedUpload {
  readonly args: readonly string[];
  readonly interactive: boolean;
}

export const prepareUpload = (snapshot: string, id: string, target: PublishSettings) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-publish-" });
  const copy = join(directory, "digests.sqlite");
  yield* fs.chmod(directory, 0o700);
  yield* exportLatestSnapshot(snapshot, copy);
  const store = yield* SnapshotStore;
  const stored = yield* store.readProfile(copy, id);

  if (stored === null) return yield* new PublishError({ message: "Cannot read the prepared upload." });

  let destination: PublishSettings["privateDestination"] = null;

  if (stored.dashboardJson !== null) {
    const document = yield* decodeSnapshotDocumentBytes(stored.dashboardJson).pipe(
      Effect.mapError(() => new PublishError({ message: "Cannot validate the prepared upload." })),
    );

    if ("personal_inputs" in document) {
      if (document.profile.id !== id) return yield* new PublishError({ message: "Upload blocked: the snapshot belongs to another profile." });

      destination = target.privateDestination;

      if (destination === null) return yield* new PublishError({
        message: "Upload blocked: private review inputs need profile approval and explicit Railway destination IDs without differing overrides.",
      });
    }
  }

  const { service, volume } = destination ?? target;

  const args = [
    "volume", ...(destination === null ? [] : ["--project", destination.project, "--environment", destination.environment]),
    "--service", service, "files", ...(volume === undefined ? [] : ["--volume", volume]),
    "upload", "--overwrite", copy, "/digests.sqlite",
  ];

  return { args, interactive: volume === undefined } satisfies PreparedUpload;
}).pipe(Effect.mapError((error) => error instanceof PublishError ? error : new PublishError({
  message: "Cannot make a private copy of the newest snapshot.",
})));

export const sendUpload = (upload: PreparedUpload, railway: string | null, root: string) => Effect.scoped(Effect.gen(function* () {
  if (railway === null || !isAbsolute(railway)) return yield* new PublishError({ message: "Railway CLI is not available on PATH." });
  const executor = yield* CommandExecutor.CommandExecutor;

  const command = Command.make(railway, ...upload.args).pipe(
    Command.workingDirectory(root), Command.stdin(upload.interactive ? "inherit" : "pipe"), Command.stdout("inherit"), Command.stderr("inherit"),
  );

  const child = yield* executor.start(command);
  const code = yield* child.exitCode;

  if (code !== 0) return yield* new PublishError({ message: `Snapshot upload failed (exit ${code}).` });
})).pipe(
  Effect.catchTags({
    SystemError: () => Effect.fail(new PublishError({ message: "Cannot start the Railway upload." })),
    BadArgument: () => Effect.fail(new PublishError({ message: "Cannot start the Railway upload." })),
  }),
  Effect.timeoutFail({ duration: "10 minutes", onTimeout: () => new PublishError({ message: "Snapshot upload timed out." }) }),
);

export const publish = (options: { readonly root: string; readonly id: string; readonly apply: boolean; readonly yes: boolean; readonly railway: () => string | null } & UploadOverrides) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const root = yield* files.root(options.root);
  const id = yield* decodeProfileId(options.id);
  const target = yield* publishSettings(root, id, options);
  yield* selectedSnapshot(root, id);
  yield* Console.log(`Publish preview: validated snapshot for profile '${id}' (data only).`);

  if (!options.apply) {
    yield* Console.log("Preview only. No upload was prepared or run. Use --apply after owner approval.");

    return 0;
  }

  if (!options.yes) {
    const terminal = yield* Terminal.Terminal;

    if (!(yield* terminal.isTTY)) return yield* new PublishError({ message: "No terminal for confirmation. Use --yes only after owner approval." });
    yield* Console.log("Type y to publish, anything else cancels:");
    const answer = yield* Effect.either(terminal.readLine);

    if (Either.isLeft(answer) || answer.right.trim() !== "y") {
      yield* Console.log("Cancelled. Nothing was run.");

      return 2;
    }
  }

  yield* withInstallationLock(root, () => Effect.scoped(Effect.gen(function* () {
    const snapshot = yield* selectedSnapshot(root, id);
    const upload = yield* prepareUpload(snapshot, id, target);
    yield* sendUpload(upload, options.railway(), root);
  })));
  yield* Console.log("Uploaded.");

  return 0;
});
