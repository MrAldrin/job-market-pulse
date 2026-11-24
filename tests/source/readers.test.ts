import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readonly Source readers preserve rows, evidence and snapshot isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-readers-"));

  try {
    const result = spawnSync("bun", ["tests/source/reader-cases.ts", join(dir, "source.db")], { encoding: "utf8", timeout: 20_000 });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
