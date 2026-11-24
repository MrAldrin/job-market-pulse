import { Data, Effect, Either, Redacted } from "effect";
import { dirname } from "node:path";
import type { TomlTable } from "smol-toml";
import { NtfySettingsInput } from "../../contracts/ntfy-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { installationLockPath, withInstallationLock, WorkflowLockError } from "../orchestration/workflow-locks.ts";
import { installationSetting, storageAnchor } from "../shared/installation-paths.ts";
import { isCanonicalPath } from "../shared/paths.ts";
import { sha256 } from "../shared/python-json.ts";
import { parseToml, writeToml } from "../shared/toml.ts";
import { ProfileFiles } from "./files.ts";

const decode = decodeStrict(NtfySettingsInput);
const off = { enabled: false, topic: null, dashboard_url: null } as const;
export const ntfySettingsPath = (root: string) => installationSetting(root, "local_only/ntfy.toml");

export class NtfySettingsError extends Data.TaggedError("NtfySettingsError")<{
  readonly code: "invalid" | "unavailable" | "changed" | "busy";
}> {}

const failure = (code: NtfySettingsError["code"] = "unavailable") => new NtfySettingsError({ code });

const validate = (input: NtfySettingsInput | TomlTable) => Either.flatMap(Either.mapLeft(decode(input), () => failure("invalid")), (value) => {
  const { enabled, topic, dashboard_url } = value;

  if (enabled && (topic === null || dashboard_url === null)) return Either.left(failure("invalid"));

  if (topic !== null && dashboard_url !== null) {
    try {
      if (decodeURIComponent(dashboard_url).toLowerCase().includes(topic.toLowerCase())) return Either.left(failure("invalid"));
    } catch {
      return Either.left(failure("invalid"));
    }
  }

  return Either.right(value);
});

const read = (root: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const path = ntfySettingsPath(root);

  if (!(yield* isCanonicalPath(path))) return yield* failure();

  if (!(yield* files.check(root, path, "File"))) return { text: null, values: off };
  yield* files.verifyPrivateFile(root, path);
  const text = yield* files.read(root, path, 4096);
  const values = yield* parseToml(text).pipe(Effect.flatMap((table) => validate({ ...off, ...table })));

  return { text, values };
}).pipe(Effect.mapError(() => failure()));

export const readNtfySettings = (root: string) => read(root).pipe(Effect.map(({ text, values }) => ({
  enabled: values.enabled, topic: values.topic === null ? null : Redacted.make(values.topic),
  dashboard_url: values.dashboard_url, revision: sha256(text ?? "missing"),
})));

export const ntfyTopicPresent = (root: string) => readNtfySettings(root).pipe(
  Effect.map(({ topic }) => topic !== null), Effect.orElseSucceed(() => false),
);

export const ntfyEnabled = (root: string) => readNtfySettings(root).pipe(
  Effect.map(({ enabled }) => enabled), Effect.orElseSucceed(() => false),
);

export const ntfySettingsView = ({ enabled, topic, dashboard_url, revision }: Effect.Effect.Success<ReturnType<typeof readNtfySettings>>) => ({
  enabled, topic_configured: topic !== null, dashboard_url, revision,
});

export const checkNtfyEdit = (current: Effect.Effect.Success<ReturnType<typeof readNtfySettings>>, input: NtfySettingsInput) =>
  Either.map(validate({ ...input, topic: input.topic ?? (current.topic === null ? null : Redacted.value(current.topic)) }), () => undefined);

export const withNtfySettingsLock = <A, R>(root: string, use: Effect.Effect<A, NtfySettingsError, R>) => Effect.gen(function* () {
  const files = yield* ProfileFiles;

  if (root !== (yield* files.root(root)) || !(yield* isCanonicalPath(installationLockPath(root)))) return yield* failure();

  return yield* withInstallationLock(root, () => use);
}).pipe(Effect.mapError((error) => error instanceof NtfySettingsError ? error : failure(error instanceof WorkflowLockError && error.code === "busy" ? "busy" : "unavailable")));

export const saveNtfySettings = (root: string, revision: string, input: NtfySettingsInput) => withNtfySettingsLock(root, Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const current = yield* read(root);

  if (sha256(current.text ?? "missing") !== revision) return yield* failure("changed");
  const values = yield* validate({ ...input, topic: input.topic ?? current.values.topic });

  if (values.enabled === current.values.enabled && values.topic === current.values.topic && values.dashboard_url === current.values.dashboard_url) return revision;

  const table: TomlTable = { enabled: values.enabled };

  if (values.topic !== null) table.topic = values.topic;

  if (values.dashboard_url !== null) table.dashboard_url = values.dashboard_url;
  const text = yield* writeToml(table);
  const path = ntfySettingsPath(root);

  if ((yield* read(root)).text !== current.text) return yield* failure("changed");

  if (current.text === null) {
    const anchor = storageAnchor(root, path);

    if (anchor !== root) yield* files.directory(root, anchor);
    yield* files.directory(root, dirname(path));
    yield* files.create(root, path, text, true);
  } else yield* files.replace(root, path, text, true);

  return sha256(text);
}).pipe(Effect.mapError((error) => error instanceof NtfySettingsError ? error : failure())));
