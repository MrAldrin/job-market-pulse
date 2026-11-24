import { Effect, Schema } from "effect";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { harnessExecutables, usesEnvNode } from "../lib/server/judge/reviewer-detect.ts";
import { fileURLToPath } from "node:url";
import { installedPaths } from "../lib/server/shared/installation-paths.ts";
import type { CheckoutReport } from "./checkout-reports.ts";

export interface DesktopLauncher {
  readonly installed: Effect.Effect<boolean>;
  readonly prepare?: Effect.Effect<boolean>;
  readonly harnessProblem?: (names: readonly string[]) => Effect.Effect<string | null>;
  readonly change: (install: boolean) => Effect.Effect<CheckoutReport>;
}

interface LauncherHost {
  readonly home: string;
  readonly dataHome: string | undefined;
  readonly bun: string;
  readonly checkout: string;
  readonly shellPath: string;
  readonly which: (name: string, searchPath?: string) => string | null;
  readonly versionOk: (executable: string, path: string) => Effect.Effect<boolean>;
  readonly refresh: (directory: string) => Effect.Effect<boolean>;
}

// Exec has two escaping layers: quoted arguments, then desktop-entry strings.
// Percent signs are Exec field codes even when part of a path.
const execPath = (path: string) => '"' + path.replace(/["`$\\]/gu, "\\$&").replaceAll("\\", "\\\\").replaceAll("%", "%%") + '"';

const validPath = (path: string) => isAbsolute(path) && !/[:\r\n\t]/u.test(path);
const fnmMultishell = (directory: string) => directory.split("/").includes("fnm_multishells");
const systemPath = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const prefix = 'Exec=/usr/bin/env ';

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

export const makeDesktopLauncher = (host: LauncherHost): DesktopLauncher => {
  const dataHome = host.dataHome && isAbsolute(host.dataHome) ? host.dataHome : join(host.home, ".local/share");
  const directory = join(dataHome, "applications");
  const path = join(directory, "job-market-pulse.desktop");
  const validExec = !host.bun.includes("=") && [host.bun, host.checkout].every((value) => isAbsolute(value) && !/[\r\n\t]/u.test(value));

  const entry = (searchPath: string) => [
    "[Desktop Entry]", "Type=Application", "Name=Job Market Pulse", "Comment=Open the local dashboard",
    `${prefix}${execPath(`PATH=${searchPath}`)} ${execPath(host.bun)} --no-env-file ${execPath(join(host.checkout, "src/cli/pulse.ts"))} desktop`,
    `Icon=${join(host.checkout, "desktop/icons/icon-512.png")}`, "Terminal=false", "Categories=Utility;", "",
  ].join("\n");

  // Accept only the generated format. Read the saved PATH, not the shell's PATH.
  const savedPath = Effect.tryPromise(async () => {
    if (!validExec || !(await lstat(path)).isFile()) return null;
    const raw = await readFile(path, "utf8");
    const match = /^Exec=\/usr\/bin\/env "PATH=((?:[^"\\\n]|\\.)*)" /mu.exec(raw);

    if (match?.[1] === undefined) return null;

    const decoded = match[1].replace(/\\\\\\\\|\\\\["`$]|%%/gu, (token) => token === "%%" ? "%" : token.slice(-1));

    return decoded.split(":").every(validPath) && raw === entry(decoded) ? decoded : null;
  }).pipe(Effect.orElseSucceed(() => null));

  const installed = Effect.map(savedPath, (value) => value !== null);

  const harnessProblem = (names: readonly string[]) => Effect.gen(function* () {
    const searchPath = yield* savedPath;

    if (searchPath === null) return null;

    for (const name of names) {
      const executable = host.which(name, searchPath);

      if (executable === null) return `${name} is not on the desktop launcher's PATH.`;

      if (!(yield* host.versionOk(executable, searchPath))) return `${name} could not report its version on the desktop launcher's PATH. Check its runtime, such as Node for Pi.`;
    }

    return null;
  });

  const resolvePath = async () => {
    const harnesses = Object.values(harnessExecutables).flatMap((name) => host.which(name) ?? []);
    const scripts = await Promise.all(harnesses.map(usesEnvNode));
    const node = scripts.includes(true) ? host.which("node") : null;
    const selected = [...new Set([dirname(host.bun), ...harnesses.map(dirname), ...(node === null ? [] : [dirname(node)])])];

    if (!selected.every(validPath)) throw new Error("Invalid launcher PATH");

    // Keep the shell's precedence when two selected directories contain the
    // same command. Do not retain unrelated PATH entries or empty segments.
    const shellOrder = host.shellPath.split(":").filter(Boolean).map((directory) => resolve(directory));
    const ordered = shellOrder.flatMap((directory) => selected.filter((candidate) => resolve(candidate) === directory));

    // fnm adds a per-shell symlink to PATH. Keep its precedence but save the
    // installation directory so the menu entry still works after shell exit.
    const stable = await Promise.all([...new Set([...ordered, ...selected])].map(async (directory) =>
      fnmMultishell(directory) ? realpath(directory) : directory));

    if (stable.some((directory) => !validPath(directory) || fnmMultishell(directory))) throw new Error("Invalid launcher PATH");

    return [...new Set([...stable, ...systemPath])].join(":");
  };

  const change = (install: boolean) => Effect.gen(function* () {
    if (install && !validExec) return { stdout: "", stderr: "Cannot write the launcher: the Bun or checkout path cannot be used in a desktop entry.\n", exitStatus: 1 };

    const stdout = yield* Effect.tryPromise(async () => {
      if (!isAbsolute(directory)) throw new Error("Invalid data directory");

      if (install) {
        const searchPath = await resolvePath();
        await mkdir(directory, { recursive: true });
        const temporary = await mkdtemp(join(directory, ".pulse-launcher-"));

        try {
          const file = join(temporary, "entry");
          await writeFile(file, entry(searchPath), { mode: 0o644 });
          await rename(file, path);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }

        return `Wrote ${path}\n`;
      }

      try {
        await unlink(path);

        return `Removed ${path}\n`;
      } catch (error) {
        if (!missing(error)) throw error;

        return null;
      }
    });

    if (stdout === null) return { stdout: `No launcher at ${path}\n`, stderr: "", exitStatus: 0 };
    const refreshed = yield* host.refresh(directory);

    return { stdout, stderr: refreshed ? "" : "Could not refresh the desktop menu database.\n", exitStatus: 0 };
  }).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: `Cannot ${install ? "write" : "remove"} ${path}\n`, exitStatus: 1 })));

  return { installed, harnessProblem, change };
};

export const nativeDesktopLauncher = (platform: NodeJS.Platform, which: LauncherHost["which"]): DesktopLauncher | undefined => {
  if (platform !== "linux" || installedPaths !== null) return undefined;

  return makeDesktopLauncher({
    home: homedir(), dataHome: process.env.XDG_DATA_HOME, bun: process.execPath,
    checkout: fileURLToPath(new URL("../../", import.meta.url)), shellPath: process.env.PATH ?? "", which,
    versionOk: (executable, searchPath) => Effect.tryPromise(async (signal) => await Bun.spawn([executable, "--version"], {
      env: { ...process.env, PATH: searchPath }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      timeout: 3_000, killSignal: "SIGKILL", signal,
    }).exited === 0).pipe(Effect.orElseSucceed(() => false)),
    refresh: (directory) => Effect.suspend(() => {
      const executable = which("update-desktop-database");

      return executable === null ? Effect.succeed(true) : Effect.tryPromise(async (signal) => await Bun.spawn([executable, directory], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 3_000, killSignal: "SIGKILL", signal,
      }).exited === 0).pipe(Effect.orElseSucceed(() => false));
    }),
  });
};
