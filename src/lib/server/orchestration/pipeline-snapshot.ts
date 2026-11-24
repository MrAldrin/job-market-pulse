import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";
import type { ModelSettings } from "../judge/reviewers.ts";
import type { LoadedProfile } from "../profile/service.ts";
import { SnapshotCapture, type SnapshotDigestInput } from "../snapshot/capture.ts";
import { SnapshotError } from "../snapshot/errors.ts";
import { projectSnapshotPersonalInputs, projectSnapshotSettings } from "../snapshot/settings.ts";
import type { PipelineStage } from "./pipeline-runner.ts";

const legacyDigestWarning = "Assumption: the selected legacy digest row is treated as this profile's digest; its original profile provenance is unknown.";

export const snapshotStage = (selected: LoadedProfile, admittedModels: () => ModelSettings | null, notificationsEnabled = false, navEvents?: () => number | undefined) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const capture = yield* SnapshotCapture;

  return {
    name: "snapshot",
    timeoutMillis: 120_000,
    run: () => Effect.gen(function* () {
      const { bundle } = selected;
      const models = admittedModels();

      if (models === null) return yield* new SnapshotError({ message: "Snapshot needs admitted review settings" });
      const settings = yield* projectSnapshotSettings(selected, models, notificationsEnabled);
      const directory = bundle.paths.directory;
      const staged = join(directory, "../../phone", `staged-digests-${bundle.profile_id}.sqlite`);

      // Choose the staged input at execution time. A selected file must pass capture validation.
      const isFile = yield* fs.stat(staged).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error)),
      );

      const digest: SnapshotDigestInput = isFile ? { kind: "store", path: staged } : { kind: "none" };

      const result = yield* capture.capture(bundle, join(directory, "dashboard-snapshot.sqlite3"), {
        digest, settings, personalInputs: projectSnapshotPersonalInputs(selected), navEvents: navEvents?.(),
        shortlist: true, companionJson: join(directory, "dashboard-snapshot.json"),
      });

      const warnings = [result.legacyAssumption ? legacyDigestWarning : null, result.digestWarning, result.jsonWarning];

      return {
        returncode: 0, stdout: `Published dashboard snapshot ${result.rowId}`, stderr: "",
        warnings: warnings.filter((warning) => warning !== null),
      };
    }).pipe(Effect.catchAll(() => Effect.succeed({ returncode: 2, stdout: "", stderr: "Cannot capture dashboard snapshot." }))),
  } satisfies PipelineStage;
});
