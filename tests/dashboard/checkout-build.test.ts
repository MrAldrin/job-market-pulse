import { mkdtemp, mkdir, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkoutBuildFingerprint, inspectCheckoutBuild, stampCheckoutBuild } from "../../src/lib/server/dashboard/checkout-build.ts";

const withCheckout = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "pulse-build-"));

  try {
    for (const path of ["build", "src", "static", "resources", "local_only"]) await mkdir(join(root, path));

    for (const path of ["vite.config.ts", "tsconfig.json", "package.json", "bun.lock", "src/test.ts"]) await writeFile(join(root, path), "before\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a checkout build needs an entry and a valid stamp", () => withCheckout(async (root) => {
  expect(await inspectCheckoutBuild(root)).toBe("missing");
  await writeFile(join(root, "build/index.js"), "// Invented build\n");
  expect(await inspectCheckoutBuild(root)).toBe("stale");
  await writeFile(join(root, "build/.pulse-inputs"), "invented corrupt stamp\n");
  expect(await inspectCheckoutBuild(root)).toBe("stale");
}));

test.skipIf(process.platform === "win32")("refuses linked inputs and names the input to replace at build time", () => withCheckout(async (root) => {
  await writeFile(join(root, "build/index.js"), "// Invented build\n");
  await stampCheckoutBuild(root, await checkoutBuildFingerprint(root));
  await symlink("../src/test.ts", join(root, "static", "linked.txt"));
  expect(await inspectCheckoutBuild(root)).toBe("unsupported");
  await expect(checkoutBuildFingerprint(root)).rejects.toThrow(
    'Cannot use dashboard build input "static/linked.txt". Replace linked or special build inputs with regular files or directories.',
  );
}));

test("compares names and content rather than time, and excludes installation data", () => withCheckout(async (root) => {
  const entry = join(root, "build/index.js");
  const source = join(root, "src/test.ts");
  const before = await checkoutBuildFingerprint(root);
  await writeFile(entry, "// Invented build\n");
  await stampCheckoutBuild(root, before);
  await writeFile(join(root, "local_only/profile.toml"), "# Invented private data\n");
  const past = new Date(1_000);
  await utimes(source, past, past);
  expect(await inspectCheckoutBuild(root)).toBe("current");

  const renamed = join(root, "src/renamed.ts");
  await rename(source, renamed);
  expect(await inspectCheckoutBuild(root)).toBe("stale");
  await rename(renamed, source);
  await writeFile(source, "after!\n");
  await utimes(source, past, past);
  expect(await inspectCheckoutBuild(root)).toBe("stale");

  // The adapter replaces its output on rebuild. A changed input prevents a stamp.
  await unlink(join(root, "build/.pulse-inputs"));
  await expect(stampCheckoutBuild(root, before)).rejects.toThrow("Dashboard inputs changed during the build.");
  expect(await inspectCheckoutBuild(root)).toBe("stale");
  await stampCheckoutBuild(root, await checkoutBuildFingerprint(root));
  expect(await inspectCheckoutBuild(root)).toBe("current");
}));
