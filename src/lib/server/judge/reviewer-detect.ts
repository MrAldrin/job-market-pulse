import type { Reviewer } from "./reviewers.ts";
import { labelPattern } from "../../contracts/reviewer-settings.ts";

// Read only the shebang. The executable can be a symlink or a large native binary.
export const usesEnvNode = async (executable: string): Promise<boolean> => {
  try {
    const file = Bun.file(executable);
    const prefix = await file.slice(0, 256).text();

    return /^#![ \t]*\/usr\/bin\/env[ \t]+(?:-S[ \t]+)?node(?:[ \t\r]*\n|[ \t]+)/u.test(prefix);
  } catch {
    return false;
  }
};

// Use a conservative floor for the startup diagnosis. A newer version can
// still fail for another reason, so do not infer a cause in that case.
export const piUsesOldNode = async (pi: string, path: string | undefined, signal: AbortSignal): Promise<boolean> => {
  try {
    if (!await usesEnvNode(pi)) return false;
    const node = path === undefined ? Bun.which("node") : Bun.which("node", { PATH: path });

    if (node === null) return false;

    return await Bun.spawn([node, "-e", 'process.exit(parseInt(process.versions.node, 10) < 20 ? 42 : 0)'], {
      env: { ...process.env, PATH: path ?? process.env.PATH, NODE_OPTIONS: undefined },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 1_000, killSignal: "SIGKILL", signal,
    }).exited === 42;
  } catch {
    return false;
  }
};

export const harnessExecutables = { "claude-code": "claude", pi: "pi" } as const;

export type Harness = keyof typeof harnessExecutables;

export type DetectedHarness = Readonly<{ harness: Harness; executable: string | null }>;

export const detectHarnesses = (which: (executable: string) => string | null): readonly DetectedHarness[] =>
  (["claude-code", "pi"] as const).map((harness) => ({ harness, executable: which(harnessExecutables[harness]) }));

export const detect = (which: (executable: string) => string | null, reviewers: readonly Reviewer[]): readonly Reviewer[] => {
  const installed = new Set(detectHarnesses(which).filter((item) => item.executable).map((item) => item.harness));

  return reviewers.filter((reviewer) => installed.has(reviewer.harness));
};

export const isolationFlags = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--no-session"] as const;
export const runTimeoutSeconds = 10;
export const runStdoutLimit = 256 * 1024;
export const listModelsArgv = (executable: string): readonly string[] => [executable, ...isolationFlags, "--list-models"];

export const helpArgv = (executable: string, harness: Harness): readonly string[] =>
  harness === "pi" ? [executable, ...isolationFlags, "--help"] : [executable, "--help"];

export type ListingKind = "ok" | "malformed" | "unsupported" | "no-rows";

export const classifyModelListing = (text: string): readonly [ListingKind, readonly string[]] => {
  if (!text || text.includes("\0")) return ["malformed", []];
  const lines = text.split(/\r?\n/);
  const header = "provider model context max-out thinking images";
  const index = lines.findIndex((line) => line.trim().split(/\s+/).join(" ") === header);

  if (index < 0) return [lines.some((line) => /^(provider|model|name|id)(\s|$)/i.test(line.trim())) ? "unsupported" : "malformed", []];
  const models = new Set<string>();

  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) break;
    const parts = line.trim().split(/\s+/);

    if (parts.length < 6) continue;
    const [provider, model, , , thinking] = parts;

    if ((thinking === "yes" || thinking === "no") && provider !== undefined && model !== undefined && labelPattern.test(provider) && labelPattern.test(model)) models.add(`${provider}/${model}`);
  }

  return models.size ? ["ok", [...models]] : ["no-rows", []];
};

const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const parseAdvertisedEfforts = (text: string, harness: Harness): ReadonlySet<string> | null => {
  const lines = text.split(/\r?\n/);
  const option = /^([ \t]*)(?:-[A-Za-z],\s*)?--(thinking|effort)(?![A-Za-z0-9-])/;
  const primary = harness === "pi" ? "thinking" : "effort";
  const find = (flag: string) => lines.findIndex((line) => option.exec(line)?.[2] === flag);
  let index = find(primary);

  if (index < 0) index = find(primary === "thinking" ? "effort" : "thinking");

  if (index < 0) return null;
  const first = lines[index]!;
  const indent = option.exec(first)![1]!.length;
  const block = [first];

  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) break;
    const followerIndent = line.length - line.trimStart().length;

    if (followerIndent <= indent && (option.test(line) || line.trimStart().startsWith("-"))) break;
    block.push(line);
  }

  const found = new Set(efforts.filter((effort) => new RegExp(`(?<![A-Za-z0-9_])${effort}(?![A-Za-z0-9_])`).test(block.join("\n"))));

  return found.size ? found : null;
};
