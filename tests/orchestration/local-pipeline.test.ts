import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("resumes the actual local workflow and captures saved review results without repeating collection inside Judge", () => {
  const result = spawnSync("bun", ["tests/orchestration/local-pipeline-bun.ts"], { encoding: "utf8", timeout: 20_000 });

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 25_000);

it("does not resubmit a matching permanent unknown model outcome after pipeline reset", () => {
  const result = spawnSync("bun", ["tests/orchestration/local-pipeline-bun.ts", "permanent-unknown"], { encoding: "utf8", timeout: 20_000 });

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 25_000);

it("the direct checkout CLI refuses an unready profile without a lock, auth check or stage", () => {
  const root = mkdtempSync(join(tmpdir(), "pulse-local-cli-"));

  try {
    const data = join(root, "data");
    mkdirSync(data);
    const output = spawnSync("bun", ["src/cli/run-local-pipeline.ts", "--root", root, "--profile", "invented", "--once"], { encoding: "utf8", timeout: 10_000 });

    expect(output.error).toBeUndefined();
    expect(output.status, output.stderr).toBe(2);
    expect(output.stderr).toBe("Profile is not ready.\n");
    expect(output.stdout).toContain('Run summary: {"status":"not_started"');
    expect(output.stdout).not.toContain("completed.");
    expect(readdirSync(data)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
