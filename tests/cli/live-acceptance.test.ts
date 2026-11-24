import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Either } from "effect";
import { expect, test } from "vitest";
import { protectedHash } from "../../scripts/live-acceptance.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";

test("protected hashes detect changes and distinguish absent legacy files from symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "pulse-hash-test-"));
  const path = join(root, "preferences.toml");
  const other = join(root, "other.toml");

  try {
    expect(protectedHash(path, true)).toBeNull();
    expect(() => protectedHash(path)).toThrow();
    writeFileSync(path, "invented one");
    const before = protectedHash(path);
    expect(protectedHash(path)).toBe(before);
    writeFileSync(path, "invented two");
    expect(protectedHash(path)).not.toBe(before);
    symlinkSync(path, other, "file");
    expect(() => protectedHash(other, true)).toThrow();
    symlinkSync(join(root, "missing"), join(root, "dangling"), "dir");
    expect(() => protectedHash(join(root, "dangling", "preferences.toml"), true)).toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});

test.skipIf(process.platform !== "linux")("acceptance preflight blocks wrong pins and missing guards, then runs guarded arguments once", () => {
  const script = resolve("scripts/live-acceptance.ts");
  const root = mkdtempSync(join(tmpdir(), "pulse-acceptance-test-"));
  const pin = "1".repeat(40);
  const marker = join(root, "invocations");
  const profile = join(root, "local_only", "profiles", "invented");

  const run = (requestedPin: string, help: string, bunArgs = ["--no-env-file"]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`, TEST_HELP: help };

    delete env.XDG_DATA_HOME;
    delete env.PULSE_ACCEPTANCE_DOTENV;

    return Bun.spawnSync([process.execPath, ...bunArgs, script, requestedPin, "invented"], { cwd: root, env });
  };

  try {
    const menu = join(root, ".local", "share", "applications");

    for (const dir of [profile, join(root, "src", "cli"), menu]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, ".env"), `XDG_DATA_HOME=${root}/other-data\nPULSE_ACCEPTANCE_DOTENV=loaded\n`);
    writeFileSync(join(root, "jj"), `#!/bin/sh\nif [ "$1" = root ]; then pwd; else printf '%s' '${pin}'; fi\n`, { mode: 0o700 });
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
    writeFileSync(join(root, "src", "cli", "pulse.ts"), `
      if (process.env.PULSE_ACCEPTANCE_DOTENV !== undefined) process.exit(12);
      if (process.argv.includes("--help")) console.log(process.env.TEST_HELP);
      else {
        const { appendFileSync } = await import("node:fs");
        appendFileSync("invocations", "run\\n");
        if (process.argv.slice(-3).join(" ") !== "refresh --no-publish --no-notify") process.exitCode = 11;
      }
    `);
    writeFileSync(join(profile, "profile.toml"), Either.getOrThrow(initialProfileConfig("invented")));

    for (const name of ["profile.md", "filters.toml", "screen.toml", "judge.toml"]) writeFileSync(join(profile, name), "invented");
    writeFileSync(join(root, "local_only", "models.toml"), "invented");
    writeFileSync(join(menu, "job-market-pulse.desktop"), "invented");

    expect(run(pin, "--no-notify", []).exitCode).toBe(2);
    expect(run(pin, "--no-notify", ["--no-env-file", "--env-file=.env"]).exitCode).toBe(2);
    expect(run("0".repeat(40), "--no-notify").exitCode).toBe(2);
    expect(run(pin, "--no-publish").exitCode).toBe(2);
    expect(existsSync(marker)).toBe(false);

    const result = run(pin, "--no-notify");

    expect(result.exitCode).toBe(0);
    expect(Bun.file(marker).size).toBe(4);
    expect(result.stdout.toString()).toContain("VERIFIED: Menu launcher unchanged");
    expect(result.stdout.toString()).not.toContain(root);
  } finally {
    rmSync(root, { recursive: true });
  }
});
