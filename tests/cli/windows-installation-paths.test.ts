import { Error as PlatformError, FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { dashboardHostEnvironment } from "../../src/lib/server/dashboard/launcher.ts";
import { unsafeWindowsSegment } from "../../src/lib/server/profile/core.ts";
import { installedExecutable, resolveInstalledPaths } from "../../src/lib/server/shared/installation-paths.ts";
import { isCanonicalPath, physicalPath } from "../../src/lib/server/shared/paths.ts";

const options = {
  platform: "win32",
  home: String.raw`C:\Users\Test User`,
  executable: String.raw`C:\Program Files\Pulse\resources\pulse.exe`,
  realpath: (path: string) => path,
} as const;

test("a Windows compiled CLI launched directly finds resources beside its executable", () => {
  expect(resolveInstalledPaths({ ...options, env: {
    APPDATA: String.raw`D:\Profile Storage\Roaming`, LOCALAPPDATA: String.raw`E:\Profile Storage\Local`,
    XDG_CONFIG_HOME: "/ignored", XDG_DATA_HOME: "/ignored",
  }, entry: "B:/~BUN/root/pulse.ts" })).toEqual({
    resources: String.raw`C:\Program Files\Pulse\resources`,
    config: String.raw`D:\Profile Storage\Roaming\job-market-pulse`,
    data: String.raw`E:\Profile Storage\Local\job-market-pulse`,
  });
  expect(installedExecutable("pulse-dashboard", "win32")).toBe("pulse-dashboard.exe");
  expect(installedExecutable("pulse-dashboard", "linux")).toBe("pulse-dashboard");
});

test("installed Windows defaults ignore unqualified paths and use an explicit resource root", () => {
  expect(resolveInstalledPaths({ ...options, env: {
    APPDATA: "D:unqualified", LOCALAPPDATA: String.raw`\no-drive`, PULSE_RESOURCE_ROOT: "D:/Pulse/resources/./",
  }, entry: "C:/repo/src/cli/pulse.ts" })).toEqual({
    resources: "D:\\Pulse\\resources\\",
    config: String.raw`C:\Users\Test User\AppData\Roaming\job-market-pulse`,
    data: String.raw`C:\Users\Test User\AppData\Local\job-market-pulse`,
  });
  expect(resolveInstalledPaths({ ...options, env: {}, entry: "C:/repo/src/cli/pulse.ts" })).toBeNull();
});

test("Windows child environment keeps the installed paths but does not pass source or model secrets", () => {
  const env = { APPDATA: "roaming", LOCALAPPDATA: "local", USERPROFILE: "home", SystemRoot: "root", PATH: "bin", ANTHROPIC_API_KEY: "not copied" };
  expect(dashboardHostEnvironment("win32", env, true, false)).toEqual({
    APPDATA: "roaming", LOCALAPPDATA: "local", USERPROFILE: "home", SystemRoot: "root",
  });
  expect(dashboardHostEnvironment("win32", env, true, true)).toEqual({
    APPDATA: "roaming", LOCALAPPDATA: "local", USERPROFILE: "home", SystemRoot: "root", PATH: "bin",
  });
});

test("Windows short directory names expand even when the final file does not exist", async () => {
  const original = String.raw`C:\Pulse\LOCAL_~1`;
  const expanded = String.raw`C:\Pulse\local_only`;
  const suffix = "\\not-created.sqlite3";

  const fs = FileSystem.layerNoop({
    readLink: () => Effect.fail(new PlatformError.SystemError({ module: "FileSystem", method: "readLink", reason: "Unknown", cause: { code: "EINVAL" } })),
    realPath: (path) => path.endsWith(suffix)
      ? Effect.fail(new PlatformError.SystemError({ module: "FileSystem", method: "realPath", reason: "NotFound" }))
      : Effect.succeed(path === original ? expanded : path),
  });

  const resolve = (path: string) => Effect.runPromise(physicalPath(path, "win32").pipe(Effect.provide(fs)));
  const canonical = (path: string) => Effect.runPromise(isCanonicalPath(path, "win32").pipe(Effect.provide(fs)));

  expect(await resolve(original + suffix)).toBe(expanded + suffix);
  expect(await canonical(original + suffix)).toBe(false);
  expect(await canonical(expanded + suffix)).toBe(true);
});

test.each(["CON", "LPT¹.txt", "aux .txt", "profile.md:stream", "profile.md.", "profile.md "])("rejects the Windows alias %s", (name) => {
  expect(unsafeWindowsSegment(name)).toBe(true);
});

test.each([".", "Østfold.md", "profile copy.md", "summary.con"])("accepts the Windows name %s", (name) => {
  expect(unsafeWindowsSegment(name)).toBe(false);
});
