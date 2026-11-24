import { Effect } from "effect";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { piUsesOldNode } from "../../src/lib/server/judge/reviewer-detect.ts";
import { makeDesktopLauncher } from "../../src/cli/desktop-launcher.ts";
import { offerDesktopLauncher } from "../../src/cli/init-wizard.ts";
import { InterviewCancelled } from "../../src/cli/interview-session.ts";

const entryName = "job-market-pulse.desktop";

test.skipIf(process.platform !== "linux")("checkout CLI installs and removes the menu entry under a temporary HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "pulse-launcher-"));
  const directory = join(home, ".local/share/applications");
  const path = join(directory, entryName);
  const bin = join(home, "bin");
  const nodeRoot = join(home, "node % runtime");
  const nodeBin = join(nodeRoot, "bin");
  const multishell = join(home, "fnm_multishells", "1234");
  const claudeBin = join(home, "claude-bin");
  const log = join(home, "refresh-log");
  const bun = process.execPath;
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: "relative-data-home", PATH: [bin, join(multishell, "bin"), claudeBin, "/usr/bin", "/bin"].join(":") };
  const command = ["--no-env-file", "src/cli/pulse.ts", "desktop"];
  const invoke = (action: string) => execFileSync(bun, [...command, action], { env, encoding: "utf8", timeout: 5_000 });

  try {
    mkdirSync(bin);
    writeFileSync(join(bin, "update-desktop-database"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/refresh-log"\n', { mode: 0o700 });
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(join(home, "fnm_multishells"));
    symlinkSync(nodeRoot, multishell);
    mkdirSync(claudeBin);
    writeFileSync(join(bin, "pi"), '#!/usr/bin/env node\n', { mode: 0o700 });
    writeFileSync(join(nodeBin, "node"), '#!/bin/sh\n[ "$1" = "$HOME/bin/pi" ] && [ "$2" = --version ]\n', { mode: 0o700 });
    const claude = join(claudeBin, "claude");
    const claudeVersion = '#!/bin/sh\n[ "$1" = --version ]\n';
    writeFileSync(claude, claudeVersion, { mode: 0o700 });
    writeFileSync(join(claudeBin, "pi"), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    writeFileSync(join(claudeBin, "node"), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const rejected = spawnSync(bun, [...command, "install-launcher", "--read-only"], { env, timeout: 5_000 });
    expect(rejected.status).toBe(2);
    expect(invoke("remove-launcher")).toContain(`No launcher at ${path}`);
    expect(invoke("install-launcher")).toContain(`Wrote ${path}`);
    const entry = readFileSync(path, "utf8");
    expect(entry).toMatch(/^Exec=\/usr\/bin\/env "PATH=\/.*" "\/.*" --no-env-file "\/.*\/src\/cli\/pulse\.ts" desktop$/mu);
    expect(entry).toContain(`PATH=${bin}:${nodeBin.replace("%", "%%")}:${claudeBin}:`);
    expect(entry).not.toContain("fnm_multishells");

    const savedDirectories = /^Exec=\/usr\/bin\/env "PATH=([^"]+)"/mu.exec(entry)?.[1]?.split(":") ?? [];
    expect(savedDirectories).toEqual(expect.arrayContaining(["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]));
    expect(new Set(savedDirectories).size).toBe(savedDirectories.length);
    writeFileSync(path, "Old entry");
    expect(invoke("install-launcher")).toContain(`Wrote ${path}`);
    expect(readFileSync(path, "utf8")).toBe(entry);
    unlinkSync(multishell);

    mkdirSync(join(home, "local_only"));

    const models = readFileSync("tests/fixtures/port-oracle/basic-run/inputs/models.toml", "utf8")
      .replace('calibrate = { harness = "pi", model = "openai/synthetic-pi-model"', 'calibrate = { harness = "claude-code", model = "synthetic-claude"');

    writeFileSync(join(home, "local_only", "models.toml"), models);

    const doctor = () => spawnSync(bun, ["--no-env-file", "src/cli/pulse.ts", "--root", home, "doctor"], {
      env: { ...env, PATH: join(home, "empty-path") }, encoding: "utf8", timeout: 5_000,
    }).stdout;

    expect(doctor()).toContain("ok  desktop_launcher  Desktop launcher installed.");
    writeFileSync(claude, '#!/bin/sh\nexit 1\n');
    expect(doctor()).toContain("claude could not report its version on the desktop launcher's PATH.");
    writeFileSync(claude, claudeVersion);
    writeFileSync(join(nodeBin, "node"), '#!/bin/sh\nexit 1\n');
    expect(doctor()).toContain("pi could not report its version on the desktop launcher's PATH.");
    expect(invoke("remove-launcher")).toContain(`Removed ${path}`);
    expect(invoke("remove-launcher")).toContain(`No launcher at ${path}`);
    expect(readFileSync(log, "utf8").trimEnd().split("\n")).toEqual([directory, directory, directory]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(process.platform !== "linux")("uses absolute XDG data home and escapes Exec paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "pulse-launcher-"));
  const dataHome = join(home, "custom data");

  const launcher = makeDesktopLauncher({
    home, dataHome, bun: '/bun "a"', checkout: '/a %f/$d/`t`/\\', refresh: () => Effect.succeed(true),
    shellPath: "", which: () => null, versionOk: () => Effect.dieMessage("Unexpected version check"),
  });

  try {
    expect(await Effect.runPromise(launcher.installed)).toBe(false);
    expect((await Effect.runPromise(launcher.change(true))).exitStatus).toBe(0);
    const path = join(dataHome, "applications", entryName);
    expect(readFileSync(path, "utf8")).toContain(String.raw` "/bun \\"a\\"" --no-env-file "/a %%f/\\$d/\\` + '`t' + String.raw`\\` + '`/' + String.raw`\\\\/src/cli/pulse.ts" desktop`);
    expect(await Effect.runPromise(launcher.installed)).toBe(true);
    expect(await Effect.runPromise(launcher.harnessProblem?.(["pi"]) ?? Effect.dieMessage("Missing probe"))).toContain("pi is not on the desktop launcher's PATH.");
    const invalid = makeDesktopLauncher({ home, dataHome, bun: "/invalid=bun", checkout: "/checkout", refresh: () => Effect.dieMessage("Unexpected refresh"), shellPath: "", which: () => null, versionOk: () => Effect.succeed(false) });
    expect(await Effect.runPromise(invalid.change(true))).toMatchObject({ exitStatus: 1, stderr: expect.stringContaining("Bun or checkout path") });
    expect(await Effect.runPromise(launcher.installed)).toBe(true);
    writeFileSync(path, "Outdated entry");
    expect(await Effect.runPromise(launcher.installed)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("classifies an old Node only for an env-node Pi", async () => {
  const home = mkdtempSync(join(tmpdir(), "pulse-node-"));
  const pi = join(home, "pi");
  const node = join(home, "node");
  const signal = new AbortController().signal;

  try {
    writeFileSync(pi, '#!/usr/bin/env node\n');
    writeFileSync(node, '#!/bin/sh\nexit 42\n', { mode: 0o700 });
    expect(await piUsesOldNode(pi, home, signal)).toBe(true);
    writeFileSync(node, '#!/bin/sh\nexit 0\n');
    expect(await piUsesOldNode(pi, home, signal)).toBe(false);
    writeFileSync(pi, '#!/bin/sh\n');
    writeFileSync(node, '#!/bin/sh\nexit 42\n');
    expect(await piUsesOldNode(pi, home, signal)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  [false, "yes", true, ["prepare", "install"]], [false, "yes", false, ["prepare"]],
  [false, "", true, []], [false, "no", true, []], [false, null, true, []], [true, null, true, []],
] as const)("init launcher offer: installed=%s, answer=%s, Electron ready=%s", async (installed, answer, ready, expected) => {
  const changes: string[] = [];
  const prompts: string[] = [];
  const output: string[] = [];
  await Effect.runPromise(offerDesktopLauncher({
    ask: (prompt) => Effect.sync(() => { prompts.push(prompt); }).pipe(Effect.zipRight(answer === null
      ? Effect.fail(new InterviewCancelled({ message: "Stopped" })) : Effect.succeed(answer))),
    say: (line) => Effect.sync(() => { output.push(line); }),
  }, {
    installed: Effect.succeed(installed),
    prepare: Effect.sync(() => {
      changes.push("prepare");

      return ready;
    }),
    change: (install) => Effect.sync(() => {
      changes.push(install ? "install" : "remove");

      return { stdout: "Wrote entry\n", stderr: "", exitStatus: 0 };
    }),
  }));
  expect(prompts).toEqual(installed ? [] : ["Add Job Market Pulse to the app menu? [y/N] "]);
  expect(changes).toEqual(expected);

  if (installed) expect(output).toEqual([]);
  else {
    expect(output[0]).toContain("a saved snapshot for the selected profile");
    expect(output[1]).toContain("bun src/cli/pulse.ts demo");

    expect(output[2]).toContain("downloads the pinned Electron runtime");

    if (answer === "yes") expect(output.at(-1)).toContain(ready ? "Wrote entry" : "The menu entry was not added");
  }
});
