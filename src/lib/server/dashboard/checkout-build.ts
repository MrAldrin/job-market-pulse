import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CheckoutBuild = "current" | "missing" | "stale" | "unsupported";

export const checkoutBuildEntry = "build/index.js";
const rebuild = "Run bun run build from the checkout root.";
const replaceLinks = "Replace linked or special build inputs with regular files or directories.";

export const checkoutBuildFix = (status: CheckoutBuild): string =>
  status === "unsupported" ? `${replaceLinks} ${rebuild}` : rebuild;

export const checkoutBuildMessages: Record<CheckoutBuild, string> = {
  current: "Dashboard build matches this checkout.",
  missing: "Dashboard build is missing.",
  stale: "Dashboard build is stale or has no valid stamp.",
  unsupported: "Dashboard build is blocked by a linked or special input.",
};

const stamp = "build/.pulse-inputs";
const stampPrefix = "v1:";
const stampLength = stampPrefix.length + 64 + 1; // Hex SHA-256 and newline.
const files = ["vite.config.ts", "tsconfig.json", "package.json", "bun.lock"];
const directories = ["src", "static", "resources"];

class UnsupportedBuildInput extends Error {
  constructor(path: string) {
    super(`Cannot use dashboard build input ${JSON.stringify(path)}. ${replaceLinks} ${rebuild}`);
  }
}

export const checkoutBuildFingerprint = async (root: string): Promise<string> => {
  const hash = createHash("sha256");

  const addFile = async (path: string) => {
    if (!(await lstat(join(root, path))).isFile()) throw new UnsupportedBuildInput(path);
    const bytes = await readFile(join(root, path));
    hash.update(JSON.stringify([path, bytes.length])).update(bytes);
  };

  const walk = async (path: string) => {
    if (!(await lstat(join(root, path))).isDirectory()) throw new UnsupportedBuildInput(path);
    const names = (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const name of names) {
      const child = `${path}/${name.name}`;

      if (name.isDirectory()) await walk(child);
      else await addFile(child);
    }
  };

  for (const path of files) await addFile(path);

  for (const path of directories) await walk(path);

  return `${stampPrefix}${hash.digest("hex")}\n`;
};

// Stamp only a successful adapter build whose inputs did not change during it.
export const stampCheckoutBuild = async (root: string, before: string): Promise<void> => {
  if (before !== await checkoutBuildFingerprint(root)) throw new Error(`Dashboard inputs changed during the build. ${rebuild}`);
  await writeFile(join(root, stamp), before, { flag: "wx" });
};

export const inspectCheckoutBuild = async (root: string): Promise<CheckoutBuild> => {
  try {
    if (!(await lstat(join(root, "build"))).isDirectory() || !(await lstat(join(root, checkoutBuildEntry))).isFile()) return "missing";
  } catch {
    return "missing";
  }

  try {
    const info = await lstat(join(root, stamp));

    if (!info.isFile() || info.size !== stampLength) return "stale";
    const previous = await readFile(join(root, stamp), "utf8");

    return previous === await checkoutBuildFingerprint(root) ? "current" : "stale";
  } catch (error) {
    return error instanceof UnsupportedBuildInput ? "unsupported" : "stale";
  }
};
