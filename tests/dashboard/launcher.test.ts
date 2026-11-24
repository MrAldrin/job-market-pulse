import { Effect, Either } from "effect";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { checkoutBuildFingerprint, stampCheckoutBuild } from "../../src/lib/server/dashboard/checkout-build.ts";
import { withInstallationLock } from "../../src/lib/server/orchestration/workflow-locks.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";

const lockState = (root: string) => Effect.runPromise(withInstallationLock(root, () => Effect.succeed("free")).pipe(
  Effect.catchTag("WorkflowLockError", (error) => Effect.succeed(error.code)),
));

const shutdownMethods = process.platform === "win32" ? ["parent pipe"] : ["terminal Ctrl+C", "parent pipe"];

test.each(shutdownMethods)("%s stops the local dashboard and waits for its refresh finalizer", async (method) => {
  const usePipe = method === "parent pipe";
  const root = await mkdtemp(join(tmpdir(), "pulse-launcher-"));
  const marker = (name: string) => join(root, name);
  let cli: Bun.Subprocess<"pipe" | "ignore", "ignore", "inherit"> | undefined;
  let interrupted = false;

  try {
    // Run the real CLI and launcher in a synthetic checkout with a fake build entry.
    const profile = join(root, "local_only", "profiles", "demo");
    await mkdir(profile, { recursive: true });
    await mkdir(join(root, "build"));

    for (const path of ["src", "resources", "static", "package.json", "bun.lock", "tsconfig.json", "vite.config.ts"]) {
      await cp(path, join(root, path), { recursive: true });
    }

    await cp("contracts/fixtures/snapshot.example.json", join(profile, "dashboard-snapshot.json"));
    await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
    await writeFile(join(profile, "profile.toml"), Either.getOrThrow(initialProfileConfig("demo")));
    await writeFile(join(root, "build", "index.js"), `import ${JSON.stringify(pathToFileURL(resolve("tests/dashboard/fixtures/launcher-refresh.ts")).href)};\n`);

    await stampCheckoutBuild(root, await checkoutBuildFingerprint(root));
    const env: NodeJS.ProcessEnv = { HOME: root, SystemRoot: process.env.SystemRoot };

    if (usePipe) env.PULSE_PARENT_PIPE = "1";

    cli = Bun.spawn([process.execPath, "--no-env-file", "src/cli/pulse.ts", "--root", root, "--profile", "demo", "dashboard"], {
      cwd: root, env,
      detached: true, stdin: usePipe ? "pipe" : "ignore", stdout: "ignore", stderr: "inherit",
    });
    await vi.waitFor(() => expect(existsSync(marker("ready"))).toBe(true), { timeout: 3_000 });
    expect(await lockState(root)).toBe("busy");

    // A terminal signals the whole foreground process group. In pipe mode,
    // closing stdin is the same request Electron sends without an OS signal.
    if (usePipe && cli.stdin) await cli.stdin.end();
    else process.kill(-cli.pid, "SIGINT");
    interrupted = true;
    await vi.waitFor(() => expect(existsSync(marker("finalizing"))).toBe(true), { timeout: 3_000 });
    expect(await lockState(root)).toBe("busy");
    expect(cli.exitCode).toBeNull();

    await writeFile(marker("release"), "");
    expect(await cli.exited).toBe(130);
    expect(await readFile(marker("signals"), "utf8")).toBe("pipe closed\n");
    expect(existsSync(marker("finalized"))).toBe(true);
    expect(await lockState(root)).toBe("free");
  } finally {
    // Unblock the fake finalizer even when an assertion fails. The fake has a watchdog.
    await writeFile(marker("release"), "");

    if (cli?.exitCode === null) {
      if (!interrupted) {
        if (usePipe && cli.stdin) await cli.stdin.end();
        else cli.kill("SIGTERM");
      }

      await cli.exited;
    }

    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
