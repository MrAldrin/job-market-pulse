import { chmod } from "node:fs/promises";
import { join } from "node:path";

// Use only on an invented file or directory owned by the test.
export const setWindowsFixturePublicRead = (path: string, allow: boolean): void => {
  const root = process.env.SystemRoot;

  if (!root || process.platform !== "win32") throw new Error("Expected native Windows for the ACL fixture");

  const executable = join(root, "System32", "icacls.exe");

  const result = Bun.spawnSync([executable, path, ...(allow ? ["/grant", "*S-1-1-0:(R)"] : ["/remove:g", "*S-1-1-0"])], {
    stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 15_000,
  });

  if (result.exitCode !== 0) throw new Error("Cannot set the synthetic Windows fixture ACL");
};

export const setFixturePublicRead = async (path: string, allow: boolean): Promise<void> => {
  if (process.platform === "win32") setWindowsFixturePublicRead(path, allow);
  else await chmod(path, allow ? 0o644 : 0o600);
};
