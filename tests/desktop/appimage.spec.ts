import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const image = resolve("local_only/package-linux/output/JobMarketPulse.AppImage");
const run = promisify(execFile);

test.skip(process.env.PULSE_APPIMAGE_SMOKE !== "1", "Run bun run test:appimage after building the AppImage.");

async function sandbox() {
  const cwd = test.info().outputPath("unrelated working directory");
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = { HOME: home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") };

  return { cwd, env };
}

async function openImage({ cwd, env }: Awaited<ReturnType<typeof sandbox>>, extra: string[] = []) {
  const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"].flatMap((key) => {
    const value = process.env[key];

    return value === undefined ? [] : [[key, value] as const];
  }));

  // Use the runtime's environment equivalent of --appimage-extract-and-run
  // so it passes Playwright's debugger arguments to the bundled Electron.
  return electron.launch({ executablePath: image, cwd, env: { ...env, ...display, APPIMAGE_EXTRACT_AND_RUN: "1" }, args: extra, chromiumSandbox: true });
}

async function close(app: ElectronApplication) {
  const exited = app.waitForEvent("close");
  // Close the real window. Killing Playwright's direct child would kill the
  // extraction runtime instead of asking Electron to stop its server.
  await Promise.all([exited, app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); })]);
}

test("runs CLI status without a display, Bun on PATH or a checkout in cwd", async () => {
  const { cwd, env } = await sandbox();
  const status = () => run(image, ["--appimage-extract-and-run", "cli", "status"], { cwd, env, timeout: 10_000 });
  const selector = join(env.XDG_CONFIG_HOME, "job-market-pulse", "local_only", "pulse.toml");
  await expect(status()).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining(selector) });
  const dryRun = await run(image, ["--appimage-extract-and-run", "cli", "init", "--step", "interview", "--dry-run"], { cwd, env, timeout: 10_000 });

  expect(dryRun.stdout).toContain("Dry run. No files were written.");
  await mkdir(dirname(selector), { recursive: true });
  await writeFile(selector, 'profile = "demo"\n');
  const profile = join(env.XDG_DATA_HOME, "job-market-pulse", "local_only", "profiles", "demo");
  await mkdir(profile, { recursive: true });
  const { stdout } = await status();
  expect(JSON.parse(stdout)).toMatchObject({ profile_id: "demo" });
});

test("opens the first-run page with the AppImage setup command", async () => {
  const app = await openImage(await sandbox());

  try {
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];

      if (!window?.isVisible()) return null;

      return window.webContents.executeJavaScript(`({
        heading: document.querySelector('h1')?.textContent,
        command: document.querySelector('pre')?.textContent,
        text: document.body.innerText,
        hasNode: 'require' in window,
      })`);
    })).toMatchObject({
      heading: "Set up Job Market Pulse", command: `'${image}' --appimage-extract-and-run cli init`,
      text: expect.stringContaining("Install and sign in to Pi or Claude Code separately for model review."), hasNode: false,
    });
  } finally {
    await close(app);
  }
});

test("opens the selected profile and keeps a concurrent demo separate", async () => {
  const dir = await sandbox();
  const selector = join(dir.env.XDG_CONFIG_HOME, "job-market-pulse", "local_only", "pulse.toml");
  const profile = join(dir.env.XDG_DATA_HOME, "job-market-pulse", "local_only", "profiles", "demo");
  await mkdir(dirname(selector), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(selector, 'profile = "demo"\n');
  const config = await readFile("config/pulse-profile.example.toml", "utf8");
  await writeFile(join(profile, "profile.toml"), config.replace('"replace-with-safe-id"', '"demo"'));
  await copyFile("contracts/fixtures/snapshot.example.json", join(profile, "dashboard-snapshot.json"));
  const normal = await openImage(dir);
  let origin: string;

  try {
    const page = await normal.firstWindow();
    await expect(page.getByRole("region", { name: "Local refresh" }).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    origin = new URL(page.url()).origin;
    const demo = await openImage(dir, ["--demo"]);

    try {
      const sample = await demo.firstWindow();
      await expect(sample.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      await expect(sample.getByRole("region", { name: "Local refresh" })).toHaveCount(0);
      const demoOrigin = new URL(sample.url()).origin;
      expect(demoOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(demoOrigin).not.toBe(origin);
      const stylesheet = sample.locator('link[rel="stylesheet"]').first();
      const href = await stylesheet.getAttribute("href");
      expect((await fetch(new URL(href ?? "", demoOrigin), { signal: AbortSignal.timeout(1_000) })).headers.get("content-type")).toContain("text/css");
    } finally {
      await close(demo);
    }
  } finally {
    await normal.evaluate(({ dialog }) => {
      // An unexpected dialog must keep the app open and fail the close check.
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await close(normal);
  }

  await expect(fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
});
