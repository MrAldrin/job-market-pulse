import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { Schema } from "effect";
import { DoctorReport } from "../../src/lib/contracts/doctor.ts";
import { LocalRunStatusResponse } from "../../src/lib/contracts/local-run.ts";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once, type EventEmitter } from "node:events";
import { copyFile, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const executablePath = resolve("node_modules/electron/dist/electron");
const entry = resolve("desktop/main.mjs");
const snapshot = resolve("contracts/fixtures/snapshot.example.json");
const run = promisify(execFile);

async function environment(root: string) {
  await mkdir(root, { recursive: true });
  const { stdout } = await run("bun", ["--no-env-file", "-e", "console.log(process.execPath)"]);

  const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"].flatMap((key) => {
    const value = process.env[key];

    return value === undefined ? [] : [[key, value] as const];
  }));

  return { ...display, HOME: root, XDG_CONFIG_HOME: root, PULSE_DESKTOP_BUN: stdout.trim(), PATH: process.env.PATH ?? "/usr/bin:/bin" };
}

const health = async (origin: string) => (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1_000) })).status;

async function expectSocketClosed(origin: string) {
  const url = new URL(origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port), signal: AbortSignal.timeout(1_000) });

  try {
    await expect(once(socket, "connect")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  } finally {
    socket.destroy();
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  await exited;
}

const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.close();
});

const closeAndWait = async (app: ElectronApplication) => {
  const closed = app.waitForEvent("close");
  await Promise.all([closed, closeWindow(app)]);
};

test("opens a saved dashboard, hands off web links, rejects a second instance and stops on close", async () => {
  const env = await environment(test.info().outputPath("home"));

  const app = await electron.launch({ executablePath, args: [entry, "dashboard", "--snapshot", snapshot],
    env: { ...env, PULSE_DESKTOP_READ_ONLY: "1" }, chromiumSandbox: true });

  const child = app.process();

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    const origin = new URL(page.url()).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await health(origin)).toBe(200);
    expect(await page.evaluate(() => "require" in window)).toBe(false);
    expect(await app.evaluate(() => process.versions.electron)).toBe("45.4.1");

    const { stdout, stderr } = await run(env.PULSE_DESKTOP_BUN, ["--no-env-file", "src/cli/pulse.ts", "desktop", "--snapshot", snapshot], { env, timeout: 8_000 });
    expect(stdout).not.toContain("Listening on");
    expect(stderr).not.toContain("Pulse desktop stopped with an error");
    expect(await health(origin)).toBe(200);

    // Record the handoff rather than opening a real browser or sending a request.
    await app.evaluate(({ shell }) => {
      const events: EventEmitter = process;
      shell.openExternal = async (url) => { events.emit("pulse-example-external", url); };
    });
    const external = app.evaluate(() => new Promise<string>((done) => process.once("pulse-example-external", done)));
    await page.evaluate(() => window.open("https://example.invalid/saved-job"));
    expect(await external).toBe("https://example.invalid/saved-job");
    await expect(page).toHaveURL(`${origin}/app/`);
    expect(app.windows()).toHaveLength(1);

    await closeAndWait(app);
    await expectSocketClosed(origin);
  } finally {
    await stop(child);
  }
});

test("refuses a stale checkout build in the CLI and desktop window until rebuilt", async () => {
  test.setTimeout(45_000);
  const root = test.info().outputPath("checkout");
  const env = await environment(test.info().outputPath("home"));
  await mkdir(join(root, "build"), { recursive: true });

  for (const input of ["src", "static", "resources", "desktop", "vite.config.ts", "tsconfig.json", "package.json", "bun.lock", "build/index.js", "build/.pulse-inputs"]) {
    await cp(resolve(input), join(root, input), { recursive: true });
  }

  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  const fix = "Run bun run build from the checkout root.";
  const hint = `Dashboard build is stale or has no valid stamp. ${fix}`;

  const cli = (...args: string[]) => ["--no-env-file", "src/cli/pulse.ts", "--root", env.HOME, ...args];
  const options = { cwd: root, env, timeout: 8_000 };

  const dashboardBuildChecks = () => {
    const doctor = spawnSync(env.PULSE_DESKTOP_BUN, cli("doctor", "--json"), { ...options, encoding: "utf8" });

    return Schema.decodeUnknownSync(DoctorReport)(JSON.parse(doctor.stdout)).checks;
  };

  const current = { id: "dashboard_build", required: false, ok: true, message: "Dashboard build matches this checkout.", fix: null };
  expect(dashboardBuildChecks()).toContainEqual(current);
  await writeFile(join(root, "static", "invented-change.txt"), "New checkout input\n");
  await expect(run(env.PULSE_DESKTOP_BUN, cli("dashboard", "--snapshot", snapshot), options)).rejects.toMatchObject({ code: 1, stderr: hint + "\n", stdout: "" });
  expect(dashboardBuildChecks()).toContainEqual({ id: "dashboard_build", required: false, ok: false,
    message: "Dashboard build is stale or has no valid stamp.", fix });

  const app = await electron.launch({ executablePath, args: [join(root, "desktop/main.mjs"), "dashboard", "--snapshot", snapshot],
    env, chromiumSandbox: true });

  const child = app.process();

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Cannot open the dashboard" })).toBeVisible();
    await expect(page.getByText(hint)).toBeVisible();
    expect(page.url()).toMatch(/^data:text\/html/u);
    await closeAndWait(app);
    expect(child.exitCode).toBe(1);
  } finally {
    await stop(child);
  }

  await run(env.PULSE_DESKTOP_BUN, ["run", "build"], { cwd: root, env, timeout: 30_000 });
  expect(dashboardBuildChecks()).toContainEqual(current);

  const rebuilt = await electron.launch({ executablePath, args: [join(root, "desktop/main.mjs"), "dashboard", "--snapshot", snapshot],
    env: { ...env, PULSE_DESKTOP_READ_ONLY: "1" }, chromiumSandbox: true });

  const rebuiltChild = rebuilt.process();

  try {
    const page = await rebuilt.firstWindow();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\//u);
    await closeAndWait(rebuilt);
    expect(rebuiltChild.exitCode).toBe(0);
  } finally {
    await stop(rebuiltChild);
  }
});

test("starts from the Pulse CLI and shuts down on a terminal stop signal", async () => {
  const env = await environment(test.info().outputPath("home"));

  const child = spawn(env.PULSE_DESKTOP_BUN, ["--no-env-file", "src/cli/pulse.ts", "desktop", "--snapshot", snapshot], {
    env, stdio: ["ignore", "pipe", "inherit"],
  });

  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

  try {
    const origin = () => /Listening on (http:\/\/127\.0\.0\.1:\d+)\//u.exec(output)?.[1];
    await expect.poll(origin, { timeout: 10_000 }).toBeDefined();
    const address = origin() ?? "";
    expect(await health(address)).toBe(200);
    await stop(child);
    await expectSocketClosed(address);
  } finally {
    await stop(child);
  }
});

for (const scenario of ["idle", "active", "lost close response"] as const) test(`closes a writable dashboard: ${scenario}`, async () => {
  const info = test.info();
  const root = info.outputPath("installation");
  const profile = join(root, "local_only", "profiles", "demo");
  const env = await environment(info.outputPath("home"));
  await mkdir(profile, { recursive: true });

  const { stdout: config } = await run("bun", ["--no-env-file", "-e", `
    import { Either } from "effect";
    import { initialProfileConfig } from "./src/lib/server/profile/core.ts";
    process.stdout.write(Either.getOrThrow(initialProfileConfig("demo")));
  `], { env });

  await writeFile(join(profile, "profile.toml"), config);
  await copyFile(snapshot, join(profile, "dashboard-snapshot.json"));
  const app = await electron.launch({ executablePath, args: [entry, "--root", root, "--profile", "demo", "dashboard"], env, chromiumSandbox: true });
  const child = app.process();

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("region", { name: "Local refresh" }).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    const origin = new URL(page.url()).origin;

    await app.evaluate(({ dialog }, scenario) => {
      const events: EventEmitter = process;
      const fetchServer = globalThis.fetch;
      let attempts = 0;
      let cancellations = 0;

      // Use the real close guard but simulate its active reply. The server
      // tests drive real admission with a fake runner, including retry waits.
      Object.assign(globalThis, { fetch: async (...[input, init]: Parameters<typeof fetch>) => {
        const closeRequest = String(input).endsWith("/app/run/desktop-close");

        if (closeRequest && init?.method === "DELETE") {
          cancellations++;

          if (scenario === "active" && cancellations === 1) throw new Error("Simulated cancel delivery failure");
        }

        const response = await fetchServer(input, init);

        if (closeRequest && response.status === 204) {
          if (init?.method === "POST" && scenario === "lost close response") throw new Error("Simulated lost close response");

          if (init?.method === "POST" && scenario === "active") return new Response("", { status: 200 });

          if (init?.method === "DELETE") events.emit("pulse-example-cancelled");
        }

        return response;
      } });
      dialog.showMessageBox = async (...args: [Electron.BaseWindow, Electron.MessageBoxOptions] | [Electron.MessageBoxOptions]) => {
        if (scenario === "idle") throw new Error("Idle close must not show a dialog");

        if (attempts++ > 0) return { response: 1, checkboxChecked: false };

        const response = new Promise<number>((done) => events.once("pulse-example-keep-open", () => done(0)));
        events.emit("pulse-example-dialog", { ...args.at(-1), cancellations });

        return { response: await response, checkboxChecked: false };
      };
    }, scenario);

    if (scenario === "lost close response") {
      const notice = app.evaluate(() => new Promise<object>((done) => process.once("pulse-example-dialog", done)));
      const cancelled = app.evaluate(() => new Promise<void>((done) => process.once("pulse-example-cancelled", done)));
      await closeWindow(app);
      expect(await notice).toMatchObject({
        message: "Pulse could not check whether a refresh is running. Closing stops any active refresh.",
        buttons: ["Keep open", "Close anyway"], defaultId: 0, cancelId: 0, cancellations: 0,
      });
      await app.evaluate(() => { const events: EventEmitter = process; events.emit("pulse-example-keep-open"); });
      await cancelled;
      expect(await health(origin)).toBe(200);
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    }

    if (scenario === "active") {
      const confirmation = app.evaluate(() => new Promise<object>((done) => process.once("pulse-example-dialog", done)));
      await closeWindow(app);
      expect(await confirmation).toMatchObject({
        message: "A refresh is running. Closing stops it.",
        buttons: ["Keep open", "Stop and close"], defaultId: 0, cancelId: 0,
      });
      const status = await fetch(`${origin}/app/run/status`, { signal: AbortSignal.timeout(1_000) });
      const { csrf_token: token } = Schema.decodeUnknownSync(LocalRunStatusResponse)(await status.json());

      const refused = await fetch(`${origin}/app/run/start`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token },
        // A nonexistent reset ID also prevents any real refresh if the guard regresses.
        body: JSON.stringify({ confirm: true, reset_run_id: "a".repeat(32) }), signal: AbortSignal.timeout(1_000),
      });

      expect(refused.status).toBe(409);
      expect(await refused.text()).toBe("The app is closing");

      const cancelled = app.evaluate(() => new Promise<void>((done) => process.once("pulse-example-cancelled", done)));
      await app.evaluate(() => { const events: EventEmitter = process; events.emit("pulse-example-keep-open"); });
      await cancelled;
      expect(await health(origin)).toBe(200);
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    }

    await closeAndWait(app);
    await expectSocketClosed(origin);
  } finally {
    await stop(child);
  }
});
