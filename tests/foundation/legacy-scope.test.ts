import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import packageJson from "../../package.json";

const legacyFiles = ["tests/pi_review_bridge.test.ts", "tests/pi_review_provider_serialization.test.ts"] as const;
const canary = "IGNORED_SYNTHETIC_TEST_CANARY_EXECUTED";

test("the legacy gate must not collect ignored same-name tests through Bun filename filters", async () => {
  // Both Bun invocations run only in this new synthetic tree, never in checkout archives.
  const sandbox = await mkdtemp(join(tmpdir(), "pulse-legacy-scope-"));

  try {
    await mkdir(join(sandbox, "tests"));
    await mkdir(join(sandbox, "local_only", "synthetic", "tests"), { recursive: true });
    await writeFile(join(sandbox, ".gitignore"), "local_only/\n");
    await writeFile(join(sandbox, "package.json"), JSON.stringify({
      scripts: { "test:legacy-harness": packageJson.scripts["test:legacy-harness"] },
    }));

    for (const file of legacyFiles) {
      await writeFile(join(sandbox, file), 'import { test, expect } from "bun:test";\ntest("synthetic canonical test", () => expect(true).toBe(true));\n');
    }

    await writeFile(join(sandbox, "local_only", "synthetic", legacyFiles[0]),
      `import { test } from "bun:test";\ntest("ignored same-name canary", () => { throw new Error("${canary}"); });\n`);

    const old = spawnSync("bun", ["test", ...legacyFiles], { cwd: sandbox, encoding: "utf8", timeout: 10_000 });
    const oldOutput = old.stdout + old.stderr;

    expect(old.error).toBeUndefined();
    expect(old.status).not.toBe(0);
    expect(oldOutput).toContain(canary);
    expect(oldOutput).toMatch(/2 pass/);
    expect(oldOutput).toMatch(/1 fail/);

    const configured = spawnSync("bun", ["run", "test:legacy-harness"], { cwd: sandbox, encoding: "utf8", timeout: 10_000 });
    const configuredOutput = configured.stdout + configured.stderr;

    expect(configured.error).toBeUndefined();
    expect(configured.status, configuredOutput).toBe(0);
    expect(configuredOutput).not.toContain(canary);
    expect(configuredOutput).toMatch(/2 pass/);
    expect(configuredOutput).toMatch(/0 fail/);
    expect(configuredOutput).toMatch(/across 2 files/);
  } finally {
    // Delete only the directory returned by this invocation's mkdtemp.
    await rm(sandbox, { recursive: true, force: true });
  }
});
