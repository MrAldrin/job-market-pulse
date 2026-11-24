import { FileSystem } from "@effect/platform";
import { Console, Context, Effect, Layer, Option } from "effect";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalSettingsTarget } from "../profile/local-settings.ts";
import { bundledResource, installedExecutable, installedPaths } from "../shared/installation-paths.ts";
import { parentPipeKey } from "../shared/parent-pipe.ts";
import type { ServeIdentity } from "./auth.ts";
import { checkoutBuildEntry, checkoutBuildFix, checkoutBuildMessages, inspectCheckoutBuild } from "./checkout-build.ts";
import { DashboardError } from "./errors.ts";

export interface DashboardLaunchRequest {
  readonly port: number;
  readonly snapshot: string;
  readonly feedback?: { readonly directory: string; readonly profileId: string };
  readonly localSettings?: LocalSettingsTarget;
  readonly serve?: ServeIdentity;
}

export class DashboardLauncher extends Context.Tag("pulse/DashboardLauncher")<DashboardLauncher, {
  readonly start: (request: DashboardLaunchRequest) => Effect.Effect<number, DashboardError>;
}>() {}

export const dashboardHostEnvironment = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, installed: boolean, settings: boolean) => {
  const keys = platform === "win32" ? ["SystemRoot", "WINDIR"] : [];

  if (platform === "win32" && (installed || settings)) keys.push("USERPROFILE", "APPDATA", "LOCALAPPDATA");

  if (settings) keys.push(...(platform === "win32" ? ["PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "HOME"]
    : ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]));

  return Object.fromEntries(keys.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]));
};

export const DashboardLauncherLive = Layer.effect(DashboardLauncher, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
  const entry = bundledResource(checkout, installedPaths === null ? checkoutBuildEntry : installedExecutable("pulse-dashboard"));
  const command = installedPaths === null ? [process.execPath, "--no-env-file", entry] : [entry];
  const error = (message: string) => new DashboardError({ message });

  return DashboardLauncher.of({
    start: ({ port, snapshot, feedback, localSettings, serve }) => Effect.scoped(Effect.gen(function* () {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return yield* error("Port must be between 1 and 65535");

      if (installedPaths === null) {
        const status = yield* Effect.promise(() => inspectCheckoutBuild(checkout));

        if (status !== "current") return yield* error(`${checkoutBuildMessages[status]} ${checkoutBuildFix(status)}`);
      } else {
        const stat = yield* fs.stat(entry).pipe(Effect.orElseSucceed(() => null));

        if (stat?.type !== "File") return yield* error("Bundled dashboard is missing.");
      }

      const origin = `http://127.0.0.1:${port}`;

      const env = {
        HOST: "127.0.0.1", PORT: String(port), PULSE_DASHBOARD_MODE: "local",
        ...(serve === undefined ? { ORIGIN: origin } : {
          PULSE_DASHBOARD_SERVE_ORIGIN: serve.origin, PULSE_DASHBOARD_SERVE_OWNER: serve.owner,
        }),
        DIGEST_VIEW_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        PULSE_DASHBOARD_SNAPSHOT: resolve(snapshot),
      };

      // Do not inherit source overrides, API keys or dashboard mode variables.
      const environment = {
        ...dashboardHostEnvironment(process.platform, process.env, installedPaths !== null, localSettings !== undefined),
        ...env, [parentPipeKey]: "1",
      };

      if (installedPaths !== null) {
        Object.assign(environment, { PULSE_RESOURCE_ROOT: installedPaths.resources });
      }

      if (feedback !== undefined) Object.assign(environment, { PULSE_DATA_DIR: feedback.directory, DIGEST_VIEW_FEEDBACK_PROFILE: feedback.profileId });

      if (localSettings !== undefined) {
        Object.assign(environment, { PULSE_LOCAL_SETTINGS_ROOT: localSettings.root, PULSE_LOCAL_SETTINGS_PROFILE: localSettings.profileId });
        const closeToken = process.env.PULSE_DESKTOP_CLOSE_TOKEN;

        if (closeToken !== undefined) Object.assign(environment, { PULSE_DESKTOP_CLOSE_TOKEN: closeToken });
      }

      // Keep terminal Ctrl+C in the CLI's process group. Give the adapter
      // time to drain (30 seconds) before forcing a stop. The pipe also closes
      // if the CLI exits without running its finalizer.
      const child = yield* Effect.acquireRelease(Effect.try({
        try: () => Bun.spawn(command, {
          env: environment, detached: true, stdin: "pipe", stdout: "inherit", stderr: "inherit",
        }),
        catch: () => error("Dashboard could not start"),
      }), (child) => Effect.gen(function* () {
        if (child.exitCode !== null) return;

        const exited = Effect.promise(() => child.exited);

        const graceful = Effect.tryPromise(async () => { await child.stdin.end(); }).pipe(
          Effect.ignore,
          Effect.zipRight(exited),
          Effect.interruptible,
          Effect.timeoutOption("35 seconds"),
        );

        if (Option.isNone(yield* graceful)) {
          child.kill("SIGKILL");
          yield* exited;
        }
      }));

      yield* Console.log(`${origin}/`);

      return yield* Effect.tryPromise({ try: () => child.exited, catch: () => error("Dashboard process failed") });
    })),
  });
}));
