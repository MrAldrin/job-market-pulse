import { Effect } from "effect";
import { join } from "node:path";
import { stageNames, type RunRecord } from "../lib/server/orchestration/pipeline-core.ts";
import { pipelineRecords } from "../lib/server/orchestration/pipeline-records.ts";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { SnapshotStore } from "../lib/server/snapshot/store.ts";
import { isProducerUtcTime } from "./display-time.ts";

type LatestRunFindings = Pick<RunRecord, "status" | "run_id" | "last_outcome" | "stage" | "failed_attempts" | "next_attempt_at"> | {
  readonly status: "unknown";
  readonly run_id: null;
  readonly last_outcome: "unknown";
  readonly evidence?: "unreadable";
};

type SnapshotFindings = { readonly status: "available"; readonly captured_at: string } | {
  readonly status: "unknown";
  readonly evidence?: "unreadable";
};

const noRun = { status: "unknown", run_id: null, last_outcome: "unknown" } as const;
const unreadableRun = { ...noRun, evidence: "unreadable" } as const;
const unreadableSnapshot = { status: "unknown", evidence: "unreadable" } as const;

const fixedRefusals = new Set([
  "review preflight could not run",
  "next_attempt_at is more than 5 hours away; record is invalid",
  "set models in local_only/models.toml, not by reviewer ID",
  "model_settings_invalid", "model_settings_unavailable", "model_provider_required",
]);

const modelSteps = ["calibrate", "judge", "rejudge", "screen"];
const permanentDetails = new Set(["invalid output", "executor error", "invalid executor result"]);

// Process exit and signal numbers are structural signed integers, not text details.
const failureExit = (value: string): boolean => {
  if (!/^-?[1-9][0-9]{0,9}$/u.test(value)) return false;
  const code = Number(value);

  return code >= -2_147_483_648 && code <= 2_147_483_647;
};

const displayOutcome = (value: string): boolean => {
  if (value === "started") return true;
  const refusal = "refused before stages: ";

  if (value.startsWith(refusal)) {
    const reason = value.slice(refusal.length);

    if (fixedRefusals.has(reason)) return true;
    // Do not allow Python's path-writability refusal to expose a basename.
    const preflight = /^review preflight refused \(exit (-?[0-9]{1,10})\)$/u.exec(reason);

    if (preflight?.[1] !== undefined) return failureExit(preflight[1]);
    const missingSteps = "model_step_missing:";

    if (!reason.startsWith(missingSteps)) return false;
    const order = reason.slice(missingSteps.length);
    const steps = order.split(",");

    return order !== "" && modelSteps.filter((step) => steps.includes(step)).join(",") === order;
  }

  // B11 Market results are best-effort warnings and never become run outcomes.
  return stageNames.some((stage) => {
    if (stage === "market") return false;

    if (value === `passed ${stage}` || value === `temporary ${stage}: timeout` || value === `temporary ${stage}: exit 75`) return true;
    const permanent = `permanent ${stage}: `;

    if (!value.startsWith(permanent)) return false;
    const detail = value.slice(permanent.length);

    return permanentDetails.has(detail) || (detail.startsWith("exit ") && detail !== "exit 75" && failureExit(detail.slice(5)));
  });
};

const selectedProfile = (rawRoot: string, profileId: string) => Effect.gen(function* () {
  const id = yield* decodeProfileId(profileId);
  const files = yield* ProfileFiles;
  const root = yield* files.root(rawRoot);
  const directory = join(root, "local_only", "profiles", id);
  // An absent profile directory is not unsafe and does not need to be created.
  yield* files.check(root, directory, "Directory");

  return { root, directory, id };
});

const readLatestRun = (root: string, directory: string, profileId: string) => pipelineRecords(root, join(directory, "local-pipeline-run.json"), profileId).pipe(
  Effect.flatMap((records) => records.read),
  Effect.match({
    onFailure: (): LatestRunFindings => unreadableRun,
    onSuccess: (run): LatestRunFindings => {
      if (run === null) return noRun;

      if (!displayOutcome(run.last_outcome) || (run.next_attempt_at !== null && !isProducerUtcTime(run.next_attempt_at))) return unreadableRun;

      return {
        status: run.status, run_id: run.run_id, last_outcome: run.last_outcome,
        stage: run.stage, failed_attempts: run.failed_attempts, next_attempt_at: run.next_attempt_at,
      };
    },
  }),
);

export const collectLatestRunFindings = (root: string, profileId: string) => selectedProfile(root, profileId).pipe(
  Effect.flatMap((selected) => readLatestRun(selected.root, selected.directory, selected.id)),
  Effect.orElseSucceed(() => unreadableRun),
);

const readSnapshot = (root: string, directory: string, profileId: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const snapshots = yield* SnapshotStore;
  const path = join(directory, "dashboard-snapshot.sqlite3");
  yield* files.check(root, path, "File");

  return yield* snapshots.readProfile(path, profileId);
}).pipe(Effect.match({
  onFailure: (): SnapshotFindings => unreadableSnapshot,
  onSuccess: (snapshot): SnapshotFindings => {
    if (snapshot === null) return { status: "unknown" };

    return isProducerUtcTime(snapshot.publishedAt) ? { status: "available", captured_at: snapshot.publishedAt } : unreadableSnapshot;
  },
}));

// Preserve the oracle's field order and separators without rewriting string values.
const fields = (value: Readonly<Record<string, string | number | boolean | null>>): string =>
  `{${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}: ${JSON.stringify(field)}`).join(", ")}}`;

export const pulseStatus = (root: string, profileId: string) => Effect.gen(function* () {
  const selected = yield* selectedProfile(root, profileId);
  const run = yield* readLatestRun(selected.root, selected.directory, selected.id);
  const snapshot = yield* readSnapshot(selected.root, selected.directory, selected.id);
  const stdout = `{"status": "local", "profile_id": ${JSON.stringify(selected.id)}, "latest_run": ${fields(run)}, "snapshot": ${fields(snapshot)}, "publication": {"status": "unknown"}}\n`;

  return { stdout, stderr: "", exitStatus: 0 };
}).pipe(Effect.orElseSucceed(() => ({
  stdout: fields({ status: "blocked", error_type: "ProfileError", notification_sent: false }) + "\n",
  stderr: "", exitStatus: 2,
})));
