import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectLatestRunFindings, pulseStatus } from "../../src/cli/pulse-status.ts";
import type { RunRecord } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { SnapshotStoreLive, publishSnapshot } from "../../src/lib/server/snapshot/store.ts";
import golden from "../oracle/basic-run/cli/operations/status.json";

const layers = Layer.merge(ProfileFilesLive, SnapshotStoreLive).pipe(Layer.provideMerge(BunFileSystem.layer));

const run = {
  run_id: "a".repeat(32), profile_id: "invented", reviewer_id: "synthetic-reviewer", status: "waiting",
  stage: "review", failed_attempts: 1, last_outcome: "temporary review: exit 75",
  next_attempt_at: "2026-10-19T12:05:00+00:00", previous_run_id: null, reset_at: null, failure_detail: "private diagnostic",
} satisfies RunRecord;

const stamp = "2026-10-19T12:00:00+00:00";
const missingRun = { status: "unknown", run_id: null, last_outcome: "unknown" };
const missingSnapshot = { status: "unknown" };
const unreadable = { evidence: "unreadable" };

const withRoot = async (use: (root: string, directory: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "pulse-status-"));

  try { await use(root, join(root, "local_only", "profiles", "invented")); }
  finally { await rm(root, { recursive: true, force: true }); }
};

const status = (root: string, id = "invented") => Effect.runPromise(pulseStatus(root, id).pipe(Effect.provide(layers)));
const latest = (root: string) => Effect.runPromise(collectLatestRunFindings(root, "invented").pipe(Effect.provide(layers)));

const publish = (path: string, id = "invented", publishedAt = stamp) => Effect.runPromise(publishSnapshot(path, {
  html: new TextEncoder().encode("private saved content"), publishedAt,
  shortlist: { profile_id: id, listing_ids: ["invented-job"] },
}));

test("matches the full frozen status result without reading profile settings or changing snapshot bytes", () => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  await symlink("missing-config-target", join(directory, "profile.toml"));
  const path = join(directory, "dashboard-snapshot.sqlite3");
  await publish(path);
  const before = await readFile(path);

  expect(await status(root)).toEqual({ stdout: golden.stdout, stderr: golden.stderr, exitStatus: golden.exit_status });
  expect(await readFile(path)).toEqual(before);
  expect((await readdir(directory)).sort()).toEqual(["dashboard-snapshot.sqlite3", "profile.toml"]);
}));

test("projects the owning run record for status and doctor without printing private diagnostics", () => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "local-pipeline-run.json");
  const record = JSON.stringify(run);
  await writeFile(path, record);

  const expected = {
    status: "waiting", run_id: run.run_id, last_outcome: run.last_outcome,
    stage: "review", failed_attempts: 1, next_attempt_at: run.next_attempt_at,
  };

  expect(await latest(root)).toEqual(expected);
  const result = await status(root);
  expect(result.stdout).not.toContain("private");
  expect(JSON.parse(result.stdout)).toEqual({
    status: "local", profile_id: "invented", latest_run: expected, snapshot: missingSnapshot, publication: { status: "unknown" },
  });
  expect(await readFile(path, "utf8")).toBe(record);
  expect(await readdir(directory)).toEqual(["local-pipeline-run.json"]);
}));

test.each([
  "started", "passed snapshot", "temporary review: timeout", "permanent resolve-locations: invalid output",
  "permanent review: executor error", "permanent snapshot: invalid executor result", "permanent sync-source: exit -15",
  "refused before stages: review preflight could not run", "refused before stages: review preflight refused (exit 2)",
  "refused before stages: next_attempt_at is more than 5 hours away; record is invalid",
  "refused before stages: set models in local_only/models.toml, not by reviewer ID",
  "refused before stages: model_settings_invalid", "refused before stages: model_settings_unavailable",
  "refused before stages: model_provider_required", "refused before stages: model_step_missing:calibrate,rejudge,screen",
])("keeps known producer outcome %s verbatim", (last_outcome) => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "local-pipeline-run.json"), JSON.stringify({ ...run, last_outcome }));

  expect(await latest(root)).toMatchObject({ last_outcome });
}));

test.each([
  "private interview notes", "temporary review: private interview notes", "temporary review: exit 75; token=private-value",
  "refused before stages: path is not writable: private-interview", "refused before stages: model_step_missing:private-interview",
  "refused before stages: review preflight refused (exit 2147483648)", "permanent review: exit -2147483649",
  "permanent review: exit 12345678901234567890", "permanent review: exit 2\u202e", "permanent review: exit 2\n",
])("makes unrecognized persisted outcome %j unreadable for status and doctor", (last_outcome) => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  const recordPath = join(directory, "local-pipeline-run.json");
  const record = JSON.stringify({ ...run, last_outcome });
  await writeFile(recordPath, record);
  await publish(join(directory, "dashboard-snapshot.sqlite3"));
  const expected = { ...missingRun, ...unreadable };

  expect(await latest(root)).toEqual(expected);
  const result = await status(root);
  expect(result).toMatchObject({ stderr: "", exitStatus: 0 });
  expect(JSON.parse(result.stdout)).toEqual({
    status: "local", profile_id: "invented", latest_run: expected,
    snapshot: { status: "available", captured_at: stamp }, publication: { status: "unknown" },
  });
  expect(await readFile(recordPath, "utf8")).toBe(record);
}));

test.each([
  ["ordinary private text", "private interview notes"],
  ["long fraction", `2026-10-19T12:00:00.${"1".repeat(4096)}+00:00`],
  ["bidi separator", "2026-10-19\u202e12:00:00+00:00"],
  ["non-producer ASCII separator", "2026-10-19 12:00:00+00:00"],
])("makes a timestamp with %s unreadable only in its own component", (_kind, timestamp) => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  const snapshotPath = join(directory, "dashboard-snapshot.sqlite3");
  const recordPath = join(directory, "local-pipeline-run.json");
  await publish(snapshotPath, "invented", timestamp);
  const snapshotBytes = await readFile(snapshotPath);
  await writeFile(recordPath, JSON.stringify(run));

  expect(JSON.parse((await status(root)).stdout)).toMatchObject({
    latest_run: { status: run.status, next_attempt_at: run.next_attempt_at }, snapshot: { ...missingSnapshot, ...unreadable },
  });
  expect(await readFile(snapshotPath)).toEqual(snapshotBytes);

  await publish(snapshotPath);
  const record = JSON.stringify({ ...run, next_attempt_at: timestamp });
  await writeFile(recordPath, record);
  expect(await latest(root)).toEqual({ ...missingRun, ...unreadable });
  expect(JSON.parse((await status(root)).stdout)).toMatchObject({
    latest_run: { ...missingRun, ...unreadable }, snapshot: { status: "available", captured_at: stamp },
  });
  expect(await readFile(recordPath, "utf8")).toBe(record);
}));

test("keeps producer microsecond timestamp bytes verbatim", () => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  const timestamp = "2026-10-19T12:05:00.001234+00:00";
  await writeFile(join(directory, "local-pipeline-run.json"), JSON.stringify({ ...run, next_attempt_at: timestamp }));
  await publish(join(directory, "dashboard-snapshot.sqlite3"), "invented", timestamp);

  expect(JSON.parse((await status(root)).stdout)).toMatchObject({
    latest_run: { next_attempt_at: timestamp }, snapshot: { captured_at: timestamp },
  });
}));

test("reports absent evidence without initializing an installation", () => withRoot(async (root) => {
  expect(await latest(root)).toEqual(missingRun);
  expect(await status(root)).toEqual({
    stdout: golden.stdout.replace(`{"status": "available", "captured_at": "${stamp}"}`, '{"status": "unknown"}'),
    stderr: "", exitStatus: 0,
  });
  expect(await readdir(root)).toEqual([]);
}));

test("blocks unsafe profile selection without disclosing its path", () => withRoot(async (root, directory) => {
  await mkdir(join(directory, ".."), { recursive: true });
  await writeFile(directory, "not a profile directory");
  const blocked = { stdout: '{"status": "blocked", "error_type": "ProfileError", "notification_sent": false}\n', stderr: "", exitStatus: 2 };

  expect(await status(root)).toEqual(blocked);
  expect(await status(root, "../private-profile")).toEqual(blocked);
  expect(await latest(root)).toEqual({ ...missingRun, ...unreadable });
}));

test.each(["wrong file kind", "profile mismatch", "invalid bytes"])("reports %s evidence as unreadable, not missing", (kind) => withRoot(async (root, directory) => {
  await mkdir(directory, { recursive: true });
  const snapshotPath = join(directory, "dashboard-snapshot.sqlite3");
  const recordPath = join(directory, "local-pipeline-run.json");

  if (kind === "wrong file kind") {
    await mkdir(snapshotPath);
    await mkdir(recordPath);
  } else if (kind === "profile mismatch") {
    await publish(snapshotPath, "other-profile");
    await writeFile(recordPath, JSON.stringify({ ...run, profile_id: "other-profile" }));
  } else {
    await writeFile(snapshotPath, "private snapshot bytes");
    await writeFile(recordPath, "private record bytes");
  }

  const result = await status(root);
  expect(result.exitStatus).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/private|other-profile/u);
  expect(JSON.parse(result.stdout)).toMatchObject({ latest_run: { ...missingRun, ...unreadable }, snapshot: { ...missingSnapshot, ...unreadable } });
  expect((await readdir(directory)).sort()).toEqual(["dashboard-snapshot.sqlite3", "local-pipeline-run.json"]);
}));
