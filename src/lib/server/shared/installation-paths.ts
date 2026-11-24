import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep, posix, win32 } from "node:path";

const appName = "job-market-pulse";
const compiledEntry = (entry: string | undefined): boolean => entry !== undefined && /^(?:[A-Z]:)?[/\\](?:\$bunfs|~BUN)[/\\]/iu.test(entry);
const main = typeof Bun === "undefined" ? undefined : Bun.main;

export const isCompiledPulse = compiledEntry(main);

export const resolveInstalledPaths = ({ platform, env, home, entry, executable, realpath }: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly entry: string | undefined;
  readonly executable: string;
  readonly realpath: (path: string) => string;
}) => {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;

  const absolute = (path: string | undefined): path is string => path !== undefined && paths.isAbsolute(path)
    && (!windows || paths.parse(path).root.length > 1);

  const override = env.PULSE_RESOURCE_ROOT;
  const resources = absolute(override) ? paths.normalize(override) : compiledEntry(entry) ? paths.dirname(executable) : null;

  if (resources === null) return null;

  // Resolve existing ancestors of each base, but not the app directory.
  // Managed file access must still reject links inside the app tree.
  const canonicalBase = (path: string): string => {
    try {
      return realpath(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return path;
      const parent = paths.dirname(path);

      return parent === path ? path : paths.join(canonicalBase(parent), paths.basename(path));
    }
  };

  const appPath = (value: string | undefined, fallback: string) => paths.join(canonicalBase(paths.normalize(absolute(value) ? value : fallback)), appName);

  return {
    resources,
    config: windows ? appPath(env.APPDATA, paths.join(home, "AppData", "Roaming")) : appPath(env.XDG_CONFIG_HOME, paths.join(home, ".config")),
    data: windows ? appPath(env.LOCALAPPDATA, paths.join(home, "AppData", "Local")) : appPath(env.XDG_DATA_HOME, paths.join(home, ".local", "share")),
  };
};

export const installedPaths = resolveInstalledPaths({
  platform: process.platform, env: process.env, home: homedir(), entry: main,
  executable: process.execPath, realpath: realpathSync,
});

export const installedExecutable = (name: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? `${name}.exe` : name;

export const bundledResource = (checkoutRoot: string, path: string): string => join(installedPaths?.resources ?? checkoutRoot, path);

export const installationSetting = (root: string, path: string): string =>
  join(installedPaths?.data === root ? installedPaths.config : root, path);

export const containsPath = (root: string, path: string): boolean => {
  const name = relative(root, path);

  return !isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep);
};

// Only the selected installed root may access its separate settings tree.
export const storageAnchor = (root: string, path: string): string => {
  if (installedPaths?.data === root && (path === installedPaths.config || containsPath(join(installedPaths.config, "local_only"), path))) return installedPaths.config;

  return root;
};
