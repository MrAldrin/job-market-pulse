import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startAppearance } from "./appearance.mjs";

const checkoutCli = fileURLToPath(new URL("../src/cli/pulse.ts", import.meta.url));
const host = "127.0.0.1";
const startupTimeout = 15_000;

// Allow the CLI to finish its 35-second dashboard shutdown before escalation.
const shutdownTimeout = 40_000;
const entryIndex = process.argv.indexOf(fileURLToPath(import.meta.url));
const checkoutArgs = entryIndex < 0 ? [] : process.argv.slice(entryIndex + 1);
const demo = app.isPackaged && process.argv.slice(1).includes("--demo");
let writable = app.isPackaged ? !demo : process.env.PULSE_DESKTOP_READ_ONLY !== "1";
const windows = process.platform === "win32";
const bundledCli = join(process.resourcesPath, windows ? "pulse.exe" : "pulse");
const { BUN_BE_BUN: _bunMode, PULSE_PARENT_PIPE: _parentPipe, PULSE_DESKTOP_CLOSE_TOKEN: _closeToken, ...parentEnv } = process.env;
const closeToken = randomBytes(32).toString("hex");
const bundledEnv = { ...parentEnv, PULSE_RESOURCE_ROOT: process.resourcesPath };

/** @type {BrowserWindow | undefined} */
let window;

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
let dashboard;

/** @type {Promise<void> | undefined} */
let dashboardExited;

/** @type {string | undefined} */
let dashboardOrigin;

/** @type {AbortController | undefined} */
let cancelRetry;
let closeSequence = 0;
let checkingClose = false;
let stopping = false;
let canQuit = false;

/** @returns {Promise<number>} */
function freePort() {
  const socket = createServer();

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, host, () => {
      const address = socket.address();
      socket.close((error) => {
        if (error || !(address instanceof Object)) reject(error ?? new Error("No loopback port"));
        else resolve(address.port);
      });
    });
  });
}

/** @param {Promise<void>} exited @param {number} timeout */
async function waitForExit(exited, timeout) {
  const timer = new AbortController();

  try {
    return await Promise.race([exited.then(() => true), delay(timeout, false, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

/** @param {number} code */
async function stop(code) {
  if (stopping) return;
  stopping = true;
  cancelRetry?.abort();

  // Wait for the CLI, not for its output pipes, which descendants can hold open.
  if (dashboard?.exitCode === null && dashboard.signalCode === null && dashboardExited) {
    if (windows) dashboard.stdin.end();
    else dashboard.kill("SIGTERM");

    if (!(await waitForExit(dashboardExited, shutdownTimeout))) {
      dashboard.kill("SIGKILL");
      await waitForExit(dashboardExited, 2_000);
    }
  }

  canQuit = true;

  if (code === 0) app.quit();
  else app.exit(code);
}

/** @param {string} origin */
async function waitForHealth(origin) {
  const end = Date.now() + startupTimeout;

  while (Date.now() < end && !stopping && dashboard?.exitCode === null && dashboard.signalCode === null) {
    const response = await fetch(origin + "/healthz", { redirect: "error", signal: AbortSignal.timeout(1_000) }).catch(() => null);

    if (response?.ok) return;
    await delay(100);
  }

  throw new Error("Dashboard did not become ready");
}

/** @param {string} value */
function httpUrl(value) {
  const url = URL.parse(value);

  return url && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null;
}

/** @param {URL | null} url */
function openInBrowser(url) {
  if (url) void shell.openExternal(url.href).catch(() => { console.error("Cannot open the link in the system browser."); });
}

/** @param {"POST" | "DELETE"} method @param {AbortSignal} [cancel] */
async function closeAdmission(method, cancel) {
  if (dashboardOrigin === undefined) throw new Error("Dashboard is not ready");

  const timeout = AbortSignal.timeout(3_000);

  const response = await fetch(dashboardOrigin + "/app/run/desktop-close", {
    method, redirect: "error", signal: cancel === undefined ? timeout : AbortSignal.any([timeout, cancel]),
    headers: { Origin: dashboardOrigin, "X-Pulse-Desktop-Token": closeToken, "X-Pulse-Close-Sequence": String(++closeSequence) },
  });

  if (response.status !== 204 && !(method === "POST" && response.status === 200)) throw new Error("Close admission failed");

  return response.status === 200;
}

async function reopenAdmission() {
  const retry = new AbortController();
  cancelRetry = retry;

  try {
    while (!retry.signal.aborted) {
      try {
        await closeAdmission("DELETE", retry.signal);

        return;
      } catch {
        await delay(500, undefined, { signal: retry.signal }).catch(() => {});
      }
    }
  } finally {
    if (cancelRetry === retry) cancelRetry = undefined;
  }
}

/** @param {number} exitStatus */
async function closeWindow(exitStatus) {
  if (checkingClose || stopping || !window) return;
  checkingClose = true;
  cancelRetry?.abort();

  try {
    if (writable && await closeAdmission("POST")) {
      if (stopping || window.isDestroyed()) return;

      const { response } = await dialog.showMessageBox(window, {
        type: "warning", title: "Close Job Market Pulse?",
        message: "A refresh is running. Closing stops it.",
        buttons: ["Keep open", "Stop and close"], defaultId: 0, cancelId: 0, noLink: true,
      });

      if (response !== 1) {
        if (!stopping) void reopenAdmission();

        return;
      }
    }

    await stop(exitStatus);
  } catch (error) {
    if (stopping || !window || window.isDestroyed()) throw error;

    console.error("Cannot confirm that the dashboard can close safely.");

    const { response } = await dialog.showMessageBox(window, {
      type: "warning", title: "Close Job Market Pulse?",
      message: "Pulse could not check whether a refresh is running. Closing stops any active refresh.",
      buttons: ["Keep open", "Close anyway"], defaultId: 0, cancelId: 0, noLink: true,
    });

    if (response === 1) {
      await stop(0);
    } else if (writable && !stopping && dashboardOrigin !== undefined) {
      // The prepare request may have reached the server even if the check failed.
      void reopenAdmission();
    }
  } finally {
    checkingClose = false;
  }
}

/** @param {string} target @param {string} [origin] @param {number} [exitStatus] */
async function showWindow(target, origin, exitStatus = 0) {
  /** @type {import("electron").WebPreferences} */
  const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "pulse-dashboard" };

  if (origin !== undefined) webPreferences.preload = fileURLToPath(new URL("./appearance-preload.cjs", import.meta.url));
  const icon = fileURLToPath(new URL("./icons/icon-512.png", import.meta.url));
  const view = new BrowserWindow({ width: 1200, height: 850, title: "Job Market Pulse", icon, show: false, webPreferences });

  window = view;
  view.removeMenu();
  const { webContents: contents } = view;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);

  contents.on("will-navigate", (event) => {
    const url = httpUrl(event.url);

    if (origin !== undefined && url?.origin === origin) return;
    event.preventDefault();

    if (origin !== undefined) openInBrowser(url);
  });
  contents.on("will-redirect", (event) => {
    if (origin === undefined || httpUrl(event.url)?.origin !== origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const link = httpUrl(url);

    if (origin !== undefined) {
      if (link?.origin === origin) void view.loadURL(link.href).catch(() => {});
      else openInBrowser(link);
    }

    return { action: "deny" };
  });

  view.on("close", (event) => {
    if (canQuit) return;
    event.preventDefault();
    void closeWindow(exitStatus).catch(() => {
      console.error("Cannot confirm that the dashboard can close safely.");
    });
  });
  view.on("closed", () => { window = undefined; });
  await view.loadURL(target);

  if (!stopping) view.show();
}

/** @param {string} text */
const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function showFirstRun() {
  writable = false;
  const appImage = process.env.APPIMAGE;
  const image = appImage && isAbsolute(appImage) ? appImage : "./JobMarketPulse.AppImage";

  const setup = windows ? `& '${bundledCli.replaceAll("'", "''")}' init`
    : `'${image.replaceAll("'", "'\\''")}' --appimage-extract-and-run cli init`;

  const refresh = windows ? "Creating a snapshot with a refresh on Windows is not supported yet."
    : "After setup, open Job Market Pulse again and select <strong>Run</strong> to get your first jobs.";

  const demoHint = windows ? "start Job Market Pulse with <code>--demo</code>" : "start the AppImage with <code>--demo</code>";

  const modelHint = windows ? "Model review needs a separate harness installation and sign-in. The Pi readiness probe still requires Linux."
    : "Install and sign in to Pi or Claude Code separately for model review.";

  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Set up Job Market Pulse</title><style>body{font:18px system-ui;max-width:48rem;margin:4rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}</style>
    <h1>Set up Job Market Pulse</h1><p>Run this command in ${windows ? "PowerShell" : "a terminal"}:</p><pre>${escapeHtml(setup)}</pre>
    <p>${modelHint}</p>
    <p>${refresh}</p>
    <p>To view invented jobs without setup, ${demoHint}.</p></html>`;

  await showWindow(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
}

async function start() {
  const executable = app.isPackaged ? bundledCli : process.env.PULSE_DESKTOP_BUN;
  const args = app.isPackaged ? [demo ? "demo" : "dashboard"] : ["--no-env-file", checkoutCli, ...checkoutArgs];

  if (!executable) throw new Error("Start from pulse desktop");
  const port = await freePort();

  if (stopping) return;
  const origin = `http://${host}:${port}`;
  const childEnv = app.isPackaged ? bundledEnv : parentEnv;

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...childEnv };

  if (windows) env.PULSE_PARENT_PIPE = "1";

  if (writable) env.PULSE_DESKTOP_CLOSE_TOKEN = closeToken;

  const child = spawn(executable, [...args, "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
  dashboard = child;
  child.stdin.on("error", () => { /* The child can exit before the pipe closes. */ });

  if (!windows) child.stdin.end();
  let missingProfile = false;
  let buildProblem = "";

  createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.startsWith("Profile not selected.")) missingProfile = true;

    if (!app.isPackaged && line.startsWith("Dashboard build is ")) buildProblem = line;
    process.stderr.write(line + "\n");
  });
  dashboardExited = new Promise((resolve) => {
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
  // On startup failure, let stderr drain before checking the reason.
  const outputClosed = new Promise((resolve) => child.once("close", resolve));

  // A free port probe does not reserve the port. Wait for the adapter's
  // listening line from OUR child before sending any request to the port.
  const lines = createInterface({ input: child.stdout });

  const listening = new Promise((resolve) => {
    lines.on("line", (line) => {
      process.stdout.write(line + "\n");

      if (line === `Listening on ${origin}/`) resolve(true);
    });
  });

  const timeout = new AbortController();

  try {
    const ready = await Promise.race([listening, outputClosed.then(() => false), delay(startupTimeout, false, { signal: timeout.signal, ref: false })]);

    if (stopping) return;

    if (!ready && app.isPackaged && !demo && child.exitCode === 2 && missingProfile) {
      await showFirstRun();

      return;
    }

    if (!ready && child.exitCode === 1 && buildProblem !== "") {
      writable = false;

      const page = `<!doctype html><html lang="en"><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Job Market Pulse</title>
        <h1>Cannot open the dashboard</h1><p>${escapeHtml(buildProblem)}</p></html>`;

      await showWindow(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`, undefined, 1);

      return;
    }

    if (!ready) throw new Error("Dashboard failed to bind");
    await waitForHealth(origin);

    dashboardOrigin = origin;

    if (!stopping) await showWindow(origin + "/app/", origin);
    void dashboardExited.then(() => {
      if (!stopping) fail("The local dashboard stopped. Check the terminal for details.");
    });
  } finally {
    timeout.abort();
  }
}

/** @param {string} message */
function fail(message) {
  if (stopping) return;
  console.error(message);
  void stop(1);
}

function runDesktop() {
  if (app.isPackaged && (app.commandLine.hasSwitch("no-sandbox") || process.env.ELECTRON_DISABLE_SANDBOX === "1")) {
    console.error(windows ? "The Job Market Pulse window requires the Chromium sandbox."
      : "The Job Market Pulse window requires the Chromium sandbox. Check Linux user namespace support.");

    return app.exit(1);
  }

  app.setName("Job Market Pulse");
  // Keep the demo's instance lock separate. It must never focus a real profile.
  app.setPath("userData", join(app.getPath("appData"), demo ? "job-market-pulse-demo" : "job-market-pulse-desktop"));
  app.commandLine.appendSwitch("disable-background-networking");

  if (!app.requestSingleInstanceLock()) return app.exit(0);
  app.on("second-instance", () => {
    if (!window || stopping) return;

    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("before-quit", (event) => {
    if (canQuit) return;
    event.preventDefault();

    if (window) window.close();
    else void stop(0);
  });
  app.on("window-all-closed", () => { void stop(0); });
  process.once("SIGINT", () => { void stop(0); });
  process.once("SIGTERM", () => { void stop(0); });
  void app.whenReady().then(() => startAppearance((event) => {
    const contents = window?.webContents;
    const frame = event.senderFrame;

    return contents !== undefined && event.sender === contents && frame !== null && frame === contents.mainFrame
      && dashboardOrigin !== undefined && httpUrl(frame.url)?.origin === dashboardOrigin;
  })).then(start).catch(() => fail("Cannot open the local dashboard. Check the terminal, saved snapshot and dashboard build."));
}

runDesktop();
