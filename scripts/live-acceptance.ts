import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Either } from "effect";
import { decodeProfileId, decodeProfileSettings, pathsFor } from "../src/lib/server/profile/core.ts";

const requireCanonicalAncestors = (path: string): void => {
  const parent = dirname(path);

  if (parent === path) return;
  requireCanonicalAncestors(parent);

  try {
    if (!lstatSync(parent).isDirectory()) throw new Error("Not a canonical directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
};

export const protectedHash = (path: string, optional = false): string | null => {
  let stat;

  try { stat = lstatSync(path); }
  catch (error) {
    if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") {
      requireCanonicalAncestors(path);

      return null;
    }

    throw error;
  }

  if (!stat.isFile() || realpathSync(path) !== path) throw new Error("Not a canonical regular file");

  return createHash("sha256").update(readFileSync(path)).digest("hex");
};

const acceptance = (args: readonly string[]): number => {
  const [pin, id] = args;

  if (process.platform !== "linux" || args.length !== 2 || !/^[0-9a-f]{40}$/u.test(pin ?? "") || !id) return 2;

  if (!process.execArgv.includes("--no-env-file") || process.execArgv.some((arg) => arg === "--env-file" || arg.startsWith("--env-file="))) return 2;

  const root = process.cwd();

  const probe = (command: string[]) => {
    const result = Bun.spawnSync(command, { stderr: "ignore" });

    if (result.exitCode !== 0) throw new Error("Probe failed");

    return result.stdout.toString().trim();
  };

  let inputs: readonly { paths: readonly string[]; optional?: boolean; label: string }[];
  let before: readonly (readonly (string | null)[])[];
  const entry = [process.execPath, "--no-env-file", "src/cli/pulse.ts"];
  const currentPin = () => probe(["jj", "--no-pager", "log", "--no-graph", "-r", "@", "-T", "commit_id"]);

  try {
    if (probe(["jj", "root"]) !== root || currentPin() !== pin) return 2;

    if (JSON.parse(readFileSync("package.json", "utf8")).packageManager !== `bun@${Bun.version}`) return 2;

    if (!probe([...entry, "refresh", "--help"]).includes("--no-notify")) return 2;

    const profileId = Either.getOrThrow(decodeProfileId(id));
    const configPath = join(root, "local_only", "profiles", profileId, "profile.toml");
    const configHash = protectedHash(configPath);
    const config = Either.getOrThrow(decodeProfileSettings(readFileSync(configPath, "utf8")));
    const paths = Either.getOrThrow(pathsFor(root, profileId, config));
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

    if (!isAbsolute(dataHome)) return 2;

    inputs = [
      { paths: [configPath, paths.narrative_file], label: "Profile" },
      { paths: ["filters.toml", "screen.toml", "judge.toml"].map((name) => join(paths.directory, name)), label: "Split preferences" },
      { paths: [paths.preferences_file], optional: true, label: "Legacy preferences" },
      { paths: [join(root, "local_only", "models.toml")], label: "Model settings" },
      { paths: [join(dataHome, "applications", "job-market-pulse.desktop")], label: "Menu launcher" },
    ];
    before = inputs.map(({ paths, optional }) => paths.map((path) => protectedHash(path, optional)));

    if (before[0]?.[0] !== configHash || currentPin() !== pin) return 2;
  } catch { return 2; }

  let completed = false;

  try {
    const run = Bun.spawnSync([...entry, "--root", root, "--profile", id, "refresh", "--no-publish", "--no-notify"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });

    completed = run.exitCode === 0;
  } catch { /* No retry. Check the protected files even if the invocation fails. */ }

  console.log(`${completed ? "VERIFIED" : "UNVERIFIED"}: Live refresh completion`);
  let unchanged = true;

  for (const [index, { paths, optional, label }] of inputs.entries()) {
    let matches = false;

    try { matches = paths.every((path, file) => protectedHash(path, optional) === before[index]?.[file]); }
    catch { /* A missing or unreadable required file is not verified. */ }

    console.log(`${matches ? "VERIFIED" : "UNVERIFIED"}: ${label} unchanged`);
    unchanged &&= matches;
  }

  return completed && unchanged ? 0 : 1;
};

if (import.meta.main) {
  const status = acceptance(process.argv.slice(2));

  if (status === 2) console.log("UNVERIFIED: Preflight did not pass. No live refresh started; no live-run hashes verified.");
  process.exitCode = status;
}
