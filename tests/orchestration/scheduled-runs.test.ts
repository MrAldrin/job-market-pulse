import { BunContext } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { finishScheduledRun, latestScheduledRun, startScheduledRun } from "../../src/lib/server/orchestration/scheduled-runs.ts";

const layer = ProfileFilesLive.pipe(Layer.provide(BunContext.layer));
const run = <A, E>(effect: Effect.Effect<A, E, import("../../src/lib/server/profile/files.ts").ProfileFiles>) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
const roots: string[] = [];
const now = "2026-11-13T14:00:00.123456+02:00";
const normalized = "2026-11-13T12:00:00.123456+00:00";

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pulse-history-"));

  roots.push(root);
  const directory = join(root, "local_only", "profiles", "sample");

  await fs.mkdir(directory, { recursive: true });

  return { root, directory, path: join(directory, "scheduled-runs.sqlite3") };
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("records running, success, and sanitized failure with last good", async () => {
  const { root, directory, path } = await fixture();

  expect(await run(latestScheduledRun(root, "sample"))).toBeNull();
  expect(await fs.readdir(directory)).toEqual([]);
  const first = await run(startScheduledRun(root, "sample", now));

  if (first === null) throw new Error("missing first run");

  expect((await run(latestScheduledRun(root, "sample")))?.status).toBe("running");
  await run(finishScheduledRun(root, "sample", first, now));
  const second = await run(startScheduledRun(root, "sample", now));

  if (second === null) throw new Error("missing second run");

  await run(finishScheduledRun(root, "sample", second, now, "token=PRIVATE"));
  expect(await run(latestScheduledRun(root, "sample"))).toEqual({ status: "failed", started_at: normalized, ended_at: normalized, failed_stage: "runner", error: "Scheduled refresh could not finish.", last_good_at: normalized });
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
});

test("read does not alter permissions", async () => {
  const { root, path } = await fixture();

  await run(startScheduledRun(root, "sample", now));
  await fs.chmod(path, 0o640);
  await run(latestScheduledRun(root, "sample"));
  expect((await fs.stat(path)).mode & 0o777).toBe(0o640);
});

test("finishing requires the intended persisted row and never recreates missing history", async () => {
  const { root, path, directory } = await fixture();
  const id = await run(startScheduledRun(root, "sample", now));

  if (id === null) throw new Error("missing run");

  await expect(run(finishScheduledRun(root, "sample", id + 1, now))).rejects.toThrow();
  expect((await run(latestScheduledRun(root, "sample")))?.status).toBe("running");
  await fs.unlink(path);
  await expect(run(finishScheduledRun(root, "sample", id, now))).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});

test("rejects naive timestamps and corrupt history without creating missing stores", async () => {
  const { root, directory, path } = await fixture();

  await expect(run(startScheduledRun(root, "sample", "2026-11-13T12:00:00"))).rejects.toThrow();
  expect(await run(latestScheduledRun(root, "sample"))).toBeNull();
  expect(await fs.readdir(directory)).toEqual([]);
  await run(startScheduledRun(root, "sample", now));
  const db = new Database(path);

  db.run("UPDATE runs SET started_at = '2026-11-13T12:00:00'");
  db.close();
  await expect(run(latestScheduledRun(root, "sample"))).rejects.toThrow();
  await fs.writeFile(path, "not SQLite");
  await expect(run(latestScheduledRun(root, "sample"))).rejects.toThrow();
});
