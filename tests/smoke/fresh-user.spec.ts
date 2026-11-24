import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Effect, Either, Schema } from "effect";
import { execFile, spawnSync } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { copyFile, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DoctorReport } from "../../src/lib/contracts/doctor.ts";
import { LocalRunStatusResponse } from "../../src/lib/contracts/local-run.ts";
import { RunRecordSchema } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { splitSettingsText } from "../../src/lib/server/profile/split-settings.ts";
import { runtime } from "../../src/lib/server/runtime.ts";
import { Source } from "../../src/lib/server/source/service.ts";

const run = promisify(execFile);
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";

const removedText = ["It does not upload to Railway.", "pulse refresh --no-publish --reset in the terminal",
  "Refresh did not complete. Check pulse status and the dashboard terminal for details.",
  "NAV changes do not cover all vacancies. FINN-sourced jobs are excluded.", "Snapshot created (UTC)", "Source check (UTC)"];

async function checkBuild(): Promise<void> {
  for (const directory of ["build/client", "build/server"]) {
    const scripts = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith(".js"));
    expect(scripts.length, directory).toBeGreaterThan(0);

    for (const file of scripts) {
      const contents = await readFile(join(directory, file), "utf8");

      for (const text of removedText) expect(contents.includes(text), `${directory}/${file}: ${text}`).toBe(false);
    }
  }
}

async function prepareMenu(home: string): Promise<string> {
  const profile = resolve("local_only/profiles/invented");
  const fixture = "tests/oracle/setup-interview/setup/files";
  await mkdir(join(profile, "outbox"), { recursive: true });

  for (const name of ["profile.toml", "profile.md"]) {
    await copyFile(join(fixture, "profiles/invented", name), join(profile, name));
  }

  const settings = Either.getOrThrow(splitSettingsText(
    await readFile(join(fixture, "profiles/invented/preferences.toml"), "utf8"),
    await readFile("config/title_exclusions.neutral.toml", "utf8"),
  ));

  for (const [name, content] of Object.entries(settings)) {
    await writeFile(join(profile, `${name}.toml`), content);
  }

  await copyFile(join(fixture, "pulse.toml"), "local_only/pulse.toml");
  await copyFile("tests/fixtures/port-oracle/basic-run/inputs/models.toml", "local_only/models.toml");
  await runtime.runPromise(Effect.flatMap(Source, (source) => source.initialize(resolve("data/nav.sqlite3"))));
  await runtime.dispose();

  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.join(' ') === '--version') console.log('0.74.0');
else if (argv.slice(0, 2).join(' ') === 'auth check' && argv.includes('--no-refresh')) {
  require('node:fs').appendFileSync(process.env.HOME + '/calls', 'Pi ready\\n');
  console.log('{"status":"ready"}');
} else process.exitCode = 2;
`, { mode: 0o700 });

  // No contact with the real scheduler or desktop menu database.
  for (const name of ["systemctl", "update-desktop-database"]) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }

  // The isolated session has no portal. Supply its preferred dark theme.
  await writeFile(join(bin, "gdbus"), `#!/bin/sh
if [ -f "$HOME/portal-unavailable" ]; then exit 1; fi
if [ "$1" = call ]; then printf '%s\\n' '(<<uint32 1>>,)'; fi
`, { mode: 0o700 });

  const multishell = join(home, "fnm_multishells/node");
  await mkdir(dirname(multishell));
  const node = process.env.PULSE_SMOKE_NODE;

  if (!node) throw new Error("Start this check with bun run test:smoke");
  await symlink(dirname(node), multishell);
  const installEnv = { ...process.env, PATH: `${bin}:${multishell}:${process.env.PATH ?? ""}` };
  await run("bun", ["--no-env-file", "src/cli/pulse.ts", "desktop", "install-launcher"], { env: installEnv, timeout: 8_000 });
  await unlink(multishell);

  const desktopFile = join(home, "data/applications/job-market-pulse.desktop");
  const entry = await readFile(desktopFile, "utf8");
  expect(entry).not.toContain("fnm_multishells");
  const exec = /^Exec=(\/usr\/bin\/env) "(PATH=[^"\\%\n]+)" "([^"\\%\n]+)" (--no-env-file) "([^"\\%\n]+)" (desktop)$/mu.exec(entry);

  if (exec === null) throw new Error("Unsupported Exec format in synthetic menu entry");

  const result = spawnSync(process.execPath, ["--no-env-file", "src/cli/pulse.ts", "doctor", "--json"], {
    env: { ...process.env, PATH: `${bin}:${dirname(node)}:/usr/bin:/bin` }, timeout: 8_000, encoding: "utf8",
  });

  if (!result.stdout) throw new Error(`No Doctor report: ${result.error ?? result.stderr}`);
  const doctor = Schema.decodeUnknownSync(DoctorReport)(JSON.parse(result.stdout));
  expect(doctor.checks.filter((check) => check.required && !check.ok)).toEqual([]);
  expect(result.status).toBe(0);

  for (const [id, ok] of [["bun", true], ["node", true], ["desktop_launcher", true], ["dashboard_build", true], ["ntfy_topic", false]] as const) {
    expect(doctor.checks).toContainEqual(expect.objectContaining({ id, ok }));
  }

  const menu = join(home, "open-menu");
  await writeFile(menu, `#!/bin/sh\nexec ${exec.slice(1).map(shellQuote).join(" ")}\n`, { mode: 0o700 });
  const dist = resolve("node_modules/electron/dist");
  await rename(dist, `${dist}-real`);
  await mkdir(dist);
  // The menu Exec and CLI arguments are unchanged. Adapt only the scratch
  // Electron binary to run without a display and expose test instrumentation.
  await writeFile(join(dist, "electron"), `#!/bin/sh\nexec ${shellQuote(join(`${dist}-real`, "electron"))} --ozone-platform=headless --disable-gpu --inspect=0 --remote-debugging-port=0 "$@"\n`, { mode: 0o700 });

  return menu;
}

let currentApp: ElectronApplication | undefined;

// A failing assertion can leave a refresh active. Do not wait for its native
// dialog during Playwright teardown. The PID namespace is the final backstop.
test.afterEach(async () => {
  await currentApp?.evaluate(({ app }) => app.exit(1)).catch(() => undefined);
});

const panel = (page: Page) => page.getByRole("region", { name: "Local refresh" });
const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });

async function closeAndCheck(app: ElectronApplication, origin: string, confirm = () => closeWindow(app)): Promise<void> {
  const child = app.process();
  await Promise.all([app.waitForEvent("close", { timeout: 8_000 }), confirm()]);
  currentApp = undefined;
  expect(child.exitCode).toBe(0);
  const url = new URL(origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port), signal: AbortSignal.timeout(1_000) });

  try {
    await expect(once(socket, "connect")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  } finally {
    socket.destroy();
  }
}

async function open(menu: string): Promise<{ app: ElectronApplication; page: Page; origin: string }> {
  const app = await electron.launch({ executablePath: menu, chromiumSandbox: true, timeout: 15_000 });
  currentApp = app;

  const page = await app.firstWindow({ timeout: 8_000 });
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.emulateMedia({ colorScheme: null });
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

  return { app, page, origin };
}

// Inspect the native dialog call without a window manager. The real close
// endpoint is used unless the test deliberately injects a failed check.
async function closePrompt(app: ElectronApplication, failed: boolean): Promise<void> {
  await app.evaluate(({ dialog }, failCheck) => {
    const fetchServer = globalThis.fetch;
    const events: EventEmitter = process;

    const patchedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const reply = await fetchServer(input, init);

      if (String(input).endsWith("/app/run/desktop-close")) {
        if (failCheck && init?.method === "POST") throw new Error("Synthetic lost close response");

        if (init?.method === "DELETE" && reply.status === 204) events.emit("pulse-smoke-reopened");
      }

      return reply;
    }, { preconnect: fetchServer.preconnect });

    globalThis.fetch = patchedFetch;
    dialog.showMessageBox = async (...args: [Electron.BaseWindow, Electron.MessageBoxOptions] | [Electron.MessageBoxOptions]) => {
      const choice = new Promise<number>((done) => events.once("pulse-smoke-close-choice", done));
      events.emit("pulse-smoke-dialog", args.at(-1));

      return { response: await choice, checkboxChecked: false };
    };
  }, failed);
}

async function expectClosePrompt(app: ElectronApplication, buttons: string[]): Promise<void> {
  const prompt = app.evaluate(() => new Promise((done) => process.once("pulse-smoke-dialog", done)));
  await closeWindow(app);
  expect(await prompt).toMatchObject({ buttons, defaultId: 0, cancelId: 0 });
}

const replyClose = (app: ElectronApplication, choice: number) => app.evaluate((_, choice) => {
  const events: EventEmitter = process;
  events.emit("pulse-smoke-close-choice", choice);
}, choice);

async function keepOpenThenClose(app: ElectronApplication, page: Page, origin: string, buttons: string[], checkOpen?: () => Promise<void>): Promise<void> {
  await expectClosePrompt(app, buttons);
  const reopened = app.evaluate(() => new Promise<void>((done) => process.once("pulse-smoke-reopened", done)));
  await replyClose(app, 0);
  await reopened;
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await checkOpen?.();
  await expectClosePrompt(app, buttons);
  await closeAndCheck(app, origin, () => replyClose(app, 1));
}

test("fresh Linux desktop from menu Exec: tabs, run, recovery and close", async () => {
  const home = process.env.HOME ?? "";
  // Refuse direct Playwright invocation on a normal host.
  expect(process.getuid?.()).not.toBe(0);
  expect(home).toMatch(/^\/tmp\/pulse-smoke\.[A-Za-z0-9]+\/home$/u);
  expect(process.cwd()).toBe(resolve(home, "../checkout"));
  expect(Object.keys(networkInterfaces())).toEqual(["lo"]);

  await test.step("scan the fresh client and server build for removed wording", checkBuild);
  // The launcher strips environment overrides. Load the fake HTTP transport
  // only in the scratch build entry and keep the built app modules unchanged.
  const entry = "build/index.js";
  await writeFile(entry, 'import "../tests/smoke/source.ts";\n' + await readFile(entry, "utf8"));
  const menu = await test.step("prepare the scratch menu and check Doctor", () => prepareMenu(home));

  await test.step("open from the menu before the first snapshot", async () => {
    const { app, page, origin } = await open(menu);
    const heading = page.getByRole("heading", { name: "No saved jobs yet" });
    await expect(heading).toBeVisible();
    const snapshot = "local_only/profiles/invented/dashboard-snapshot.json";
    await expect(readFile(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fetch(`${origin}/app/snapshot.json`)).status).toBe(404);
    await panel(page).getByRole("button", { name: "Run", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Start a refresh?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(heading).toBeVisible();
    await expect(readFile(join(home, "calls"))).rejects.toMatchObject({ code: "ENOENT" });

    await copyFile("tests/oracle/basic-run/snapshot/snapshot-v1.json", snapshot);
    await page.reload();
    await expect(page.getByRole("heading", { name: "1 recommended job" })).toBeVisible();
    await closeAndCheck(app, origin);
  });

  const firstOrigin = await test.step("open from the menu and visit all seven tabs, then close while idle", async () => {
    const { app, page, origin } = await open(menu);
    const nav = page.getByRole("navigation", { name: "Main navigation" });

    for (const tab of ["Jobs", "Market", "Salary", "Settings", "About", "Run", "Home"]) {
      await nav.getByRole("link", { name: tab, exact: true }).click();
      await expect(page).toHaveTitle(`${tab} · Job Market Pulse`);
      const heading = tab === "Home" ? "1 recommended job" : tab;
      await expect(page.getByRole("main").getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    }

    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Color theme" });
    await expect(theme).toHaveValue("system");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
    await theme.selectOption("light");
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);
    await closeAndCheck(app, origin);

    return origin;
  });

  await test.step("restore the saved theme on a new port and fall back when the portal is absent", async () => {
    await writeFile(join(home, "portal-unavailable"), "");
    const firstPort = createServer();
    await once(firstPort.listen(Number(new URL(firstOrigin).port), "127.0.0.1"), "listening");

    try {
      const { app, page, origin } = await open(menu);
      expect(origin).not.toBe(firstOrigin);
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      const theme = page.getByRole("combobox", { name: "Color theme" });
      await expect(theme).toHaveValue("light");
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);
      await theme.selectOption("dark");
      await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
      await theme.selectOption("system");
      await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
      await closeAndCheck(app, origin);
    } finally {
      await new Promise<void>((done) => firstPort.close(() => done()));
    }
  });

  await test.step("start in the Run tab, recover a stopped run, then close during Source", async () => {
    const { app, page, origin } = await open(menu);

    const status = async () => Schema.decodeUnknownSync(LocalRunStatusResponse)(await (await fetch(`${origin}/app/run/status`, {
      signal: AbortSignal.timeout(1_000),
    })).json());

    const record = () => readFile("local_only/profiles/invented/local-pipeline-run.json", "utf8")
      .then(Schema.decodeUnknownSync(Schema.parseJson(RunRecordSchema.pick("run_id", "previous_run_id", "stage", "status"))));

    await page.getByRole("link", { name: "Run", exact: true }).click();
    await panel(page).getByRole("button", { name: "Start refresh", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Start a refresh?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Start refresh" }).click();
    await expect(page.getByRole("list", { name: "Refresh stages" })).toContainText("Read NAV");
    await expect(page.getByRole("log", { name: "Refresh log" })).toContainText("Reading NAV.");
    const calls = () => readFile(join(home, "calls"), "utf8").catch(() => "");
    await expect.poll(calls).toMatch(/^(Pi ready\n)+Feed\n$/u);
    expect(await status()).toMatchObject({ status: "running", current_stage: "sync-source" });

    const release = join(home, "release-feed");
    await writeFile(release, "");
    const reset = panel(page).getByRole("button", { name: "Reset and run", exact: true });
    await expect(reset).toBeVisible();
    const { reset_run_id: oldId } = await status();
    expect(oldId).toMatch(/^[0-9a-f]{32}$/u);
    await unlink(release);
    await reset.click();
    const recover = page.getByRole("alertdialog", { name: "Reset the stopped run and start a new refresh?" });
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === "/app/run/start");
    await recover.getByRole("button", { name: "Reset and run" }).click();
    expect((await accepted).status()).toBe(202);
    await expect.poll(calls).toMatch(/^(?:(?:Pi ready\n)+Feed\n){2}$/u);
    const restarted = await record();
    expect(restarted).toMatchObject({ previous_run_id: oldId, stage: "sync-source", status: "running" });
    expect(restarted.run_id).not.toBe(oldId);
    await closePrompt(app, false);
    await keepOpenThenClose(app, page, origin, ["Keep open", "Stop and close"], async () => {
      expect(await status()).toMatchObject({ status: "running", current_stage: "sync-source" });
      expect(await record()).toMatchObject({ run_id: restarted.run_id, status: "running" });
    });
  });

  await test.step("keep open and then close anyway after a failed close check", async () => {
    const { app, page, origin } = await open(menu);
    await closePrompt(app, true);
    await keepOpenThenClose(app, page, origin, ["Keep open", "Close anyway"]);
  });
});
