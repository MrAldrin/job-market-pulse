import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../scripts/check-private-values.ts", import.meta.url));
const tailnet = ["invented-node", "invented-tail", "ts", "net"].join(".");
const railway = `https://${["invented-service", "up", "railway", "app"].join(".")}`;
const privateValue = "Invented+Token";

let root: string;

function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, checker, "--root", root, ...args]);

  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

function writeList(content: string): void {
  mkdirSync(join(root, "local_only/config"), { recursive: true });
  writeFileSync(join(root, "local_only/config/private-strings.txt"), content);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pulse-private-values-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("private-value publication guard", () => {
  it("passes the tracked check on clean inputs without reading untracked files or following links", () => {
    git("init", "--quiet");
    writeFileSync(join(root, "clean.txt"), "https://viewer.example\nhttps://node.tail.example\n");
    writeFileSync(join(root, "untracked.txt"), tailnet);
    writeFileSync(join(root, "image.bin"), new Uint8Array([0, 1, 2]));
    symlinkSync("untracked.txt", join(root, "link"));
    git("add", "clean.txt", "image.bin", "link");

    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain("backup patterns only");
    expect(result.output).toContain("3 paths, 1 non-text bodies skipped, 0 findings");
    expect(run("--require-list").code).toBe(2);
    writeList(privateValue);
    expect(run("--require-list").code).toBe(0);
  });

  it("reports release findings without values, even in a file name", () => {
    const stage = join(root, "release");
    mkdirSync(stage);
    writeList(`# ignored\n\n ${privateValue} \n1706\n`);
    writeFileSync(join(stage, "candidate.txt"), `${tailnet}\n${railway}\nX${privateValue}\n${privateValue.toLowerCase()}\n1706.25\n1706\n`);
    writeFileSync(join(stage, tailnet), "not a body match");

    const result = run("--release-dir", stage, "--require-list");
    expect(result.code).toBe(1);
    expect(result.output).toContain('"candidate.txt":1: tailnet-hostname');
    expect(result.output).toContain('"candidate.txt":2: railway-url');
    expect(result.output).toContain('"candidate.txt":4: private-string-1');
    expect(result.output).toContain('"candidate.txt":6: private-string-2');
    expect(result.output).toContain("[redacted path]:0: tailnet-hostname");
    expect(result.output).toContain("5 findings");

    for (const value of [tailnet, railway, privateValue.toLowerCase(), "1706"]) {
      expect(result.output).not.toContain(value);
    }
  });

  it("rejects a release directory that contains a Beads tree before scanning it", () => {
    const stage = join(root, "release");
    mkdirSync(join(stage, ".beads"), { recursive: true });
    writeFileSync(join(stage, ".beads", "invented.txt"), tailnet);
    const result = run("--release-dir", stage);

    expect(result.code).toBe(2);
    expect(result.output).not.toContain("invented.txt");
    expect(result.output).not.toContain("tailnet-hostname");
    expect(run("--release-dir", join(stage, ".beads")).code).toBe(2);
  });

  it("fails if a required list is missing or a supplied list is empty", () => {
    const stage = join(root, "release");
    mkdirSync(stage);
    writeFileSync(join(stage, "clean.txt"), "example");
    expect(run("--release-dir", stage, "--require-list").code).toBe(2);
    writeList("# empty\n");
    expect(run("--release-dir", stage).code).toBe(2);
  });
});
