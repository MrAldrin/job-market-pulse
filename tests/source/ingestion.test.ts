import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("Source ingestion commits whole pages and preserves bounded lifecycle evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-ingestion-"));

  try {
    const result = spawnSync("bun", ["tests/source/ingestion-cases.ts", directory], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ingestion: passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
