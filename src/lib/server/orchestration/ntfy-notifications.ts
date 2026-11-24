import { Effect, Option } from "effect";
import { join } from "node:path";
import { decodeSnapshotDocumentBytes } from "../../contracts/snapshot.ts";
import { newTopJobsMessage, NtfyTransport, scheduledFailureMessage, topJobIds } from "../alert/ntfy.ts";
import { ProfileFiles } from "../profile/files.ts";
import { readNtfySettings } from "../profile/ntfy-settings.ts";
import { isCanonicalPath } from "../shared/paths.ts";
import { SnapshotStore } from "../snapshot/store.ts";

const readSnapshot = (root: string, id: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const store = yield* SnapshotStore;
  const path = join(root, "local_only", "profiles", id, "dashboard-snapshot.sqlite3");

  if (!(yield* isCanonicalPath(path))) return yield* Effect.fail(undefined);

  if (!(yield* files.check(root, path, "File"))) return null;
  const record = yield* store.readProfile(path, id);

  if (!record?.dashboardJson) return yield* Effect.fail(undefined);
  const document = yield* decodeSnapshotDocumentBytes(record.dashboardJson);

  return document.profile.id === id ? document : yield* Effect.fail(undefined);
});

// Best effort. Notification data and transport failures do not change the run.
export const prepareTopJobsAlert = (root: string, id: string) => Effect.gen(function* () {
  const transport = yield* Effect.serviceOption(NtfyTransport);

  if (Option.isNone(transport)) return Effect.void;
  const initial = yield* readNtfySettings(root);

  if (!initial.enabled) return Effect.void;
  const previous = yield* readSnapshot(root, id);
  const before = previous === null ? new Set<string>() : topJobIds(previous);
  const snapshotContext = yield* Effect.context<Effect.Effect.Context<ReturnType<typeof readSnapshot>>>();

  return Effect.gen(function* () {
    const after = yield* readSnapshot(root, id);

    if (after === null) return;
    // A run can take long enough for storage permissions to change.
    const { enabled, topic, dashboard_url, revision } = yield* readNtfySettings(root);

    if (!enabled || topic === null || dashboard_url === null || revision !== initial.revision) return;
    const message = newTopJobsMessage(before, after, dashboard_url, topic);

    if (message !== null) yield* transport.value.post(topic, message);
  }).pipe(Effect.provide(snapshotContext), Effect.ignore, Effect.catchAllDefect(() => Effect.void));
}).pipe(Effect.orElseSucceed(() => Effect.void), Effect.catchAllDefect(() => Effect.succeed(Effect.void)));

export const alertScheduledFailure = (root: string) => Effect.gen(function* () {
  const transport = yield* Effect.serviceOption(NtfyTransport);

  if (Option.isNone(transport)) return;
  const { enabled, topic } = yield* readNtfySettings(root);

  if (enabled && topic !== null) yield* transport.value.post(topic, scheduledFailureMessage);
}).pipe(Effect.ignore, Effect.catchAllDefect(() => Effect.void));
