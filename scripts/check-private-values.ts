import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const backupRules = [
  ["tailnet-hostname", /\b[a-z0-9][a-z0-9.-]*\.ts\.net\b/i],
  ["railway-url", /\bhttps?:\/\/[a-z0-9][a-z0-9-]*\.(?:up\.)?railway\.app\b/i],
] as const;

const decoder = new TextDecoder("utf-8", { fatal: true });
const privateReleaseNames = [".git", ".jj", ".beads", "local_only"];

function privateRules(root: string, required: boolean) {
  let content: string;

  try {
    content = decoder.decode(readFileSync(join(root, "local_only/config/private-strings.txt")));
  } catch (error) {
    if (required || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;

    console.error("Private string list absent; checking backup patterns only.");

    return [];
  }

  const entries = content.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

  if (entries.length === 0) throw new Error("Empty private list");

  return entries.map((value, index) => {
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value);
    const boundary = numeric ? "[\\p{L}\\p{N}.]" : "[\\p{L}\\p{N}]";
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return [`private-string-${index + 1}`, new RegExp(`(?<!${boundary})${literal}(?!${boundary})`, "iu")] as const;
  });
}

function trackedPaths(root: string): string[] {
  const jj = existsSync(join(root, ".jj"));

  if (!jj && !existsSync(join(root, ".git"))) throw new Error("Not a checkout root");

  const command = jj
    ? ["jj", "--no-pager", "file", "list", "-T", String.raw`path ++ "\0"`]
    : ["git", "ls-files", "--cached", "-z"];

  const result = Bun.spawnSync(command, { cwd: root, stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error("Cannot list tracked paths");

  return [...new Set(decoder.decode(result.stdout).split("\0").filter(Boolean))];
}

function* releasePaths(root: string, prefix = ""): Generator<string> {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);

    if (privateReleaseNames.includes(entry.name)) {
      throw new Error("Staging directory contains checkout metadata or local data");
    }

    if (entry.isDirectory()) yield* releasePaths(root, path);
    else yield path;
  }
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);

  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

function readInput(root: string, name: string): Uint8Array {
  const path = resolve(root, name);

  if (!inside(root, path) || !inside(root, realpathSync(dirname(path)))) {
    throw new Error("Path leaves scan root");
  }

  const stat = lstatSync(path);

  if (stat.isSymbolicLink()) return readlinkSync(path, { encoding: "buffer" });

  if (!stat.isFile()) throw new Error("Unsupported input type");

  return readFileSync(path);
}

function main(): number {
  try {
    const { values } = parseArgs({ options: {
      root: { type: "string" },
      "release-dir": { type: "string" },
      "require-list": { type: "boolean" },
    } });

    const root = realpathSync(values.root ?? join(import.meta.dir, ".."));
    const rules = [...backupRules, ...privateRules(root, values["require-list"] ?? false)];
    const release = values["release-dir"];
    const scanRoot = release === undefined ? root : realpathSync(release);

    if (release !== undefined && scanRoot.split(sep).some((name) => privateReleaseNames.includes(name))) {
      throw new Error("Staging directory is inside checkout metadata or local data");
    }

    const paths = release === undefined ? trackedPaths(root) : [...releasePaths(scanRoot)];

    if (paths.length === 0) throw new Error("No scan inputs");

    let hits = 0;
    let nonText = 0;

    for (const name of paths) {
      const nameRules = rules.filter(([, pattern]) => pattern.test(name));
      const label = nameRules.length === 0 ? JSON.stringify(name) : "[redacted path]";

      const report = (line: number, rule: string): void => {
        console.log(`${label}:${line}: ${rule}`);
        hits++;
      };

      for (const [rule] of nameRules) report(0, rule);
      const raw = readInput(scanRoot, name);
      let content: string;

      try {
        if (raw.includes(0)) throw new Error("Non-text input");

        content = decoder.decode(raw);
      } catch {
        nonText++;
        continue;
      }

      for (const [index, line] of content.split(/\r\n|\n|\r/).entries()) {
        for (const [rule, pattern] of rules) if (pattern.test(line)) report(index + 1, rule);
      }
    }

    console.log(`Private-value check: ${paths.length} paths, ${nonText} non-text bodies skipped, ${hits} findings.`);

    return hits === 0 ? 0 : 1;
  } catch {
    console.error("Private-value check could not read inputs. Check options, scan root, and private list (if required or present).");

    return 2;
  }
}

process.exitCode = main();
