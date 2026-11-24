import { execFile, spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { app, ipcMain, nativeTheme } from "electron";

/** @typedef {"system" | "light" | "dark"} Theme */
/** @param {unknown} value @returns {value is Theme} */
const isTheme = (value) => value === "system" || value === "light" || value === "dark";

const destination = "org.freedesktop.portal.Desktop";
const portalPath = "/org/freedesktop/portal/desktop";
const appearance = "org.freedesktop.appearance";

// Some Linux desktops report their preference through the portal, not GTK.
function watchLinuxAppearance(/** @type {(theme: Theme) => void} */ update) {
  if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) return Promise.resolve();

  let generation = 0;
  let observed = false;

  const monitor = spawn("gdbus", ["monitor", "--session", "--dest", destination, "--object-path", portalPath],
    { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });

  monitor.on("error", () => {});
  app.once("quit", () => monitor.kill());

  /** @param {string} value */
  function apply(value) {
    const scheme = /<uint32 ([012])>/.exec(value)?.[1];

    if (scheme === "1") update("dark");
    else if (scheme === "2") update("light");
    else if (scheme === "0") update("system");
  }

  createInterface({ input: monitor.stdout }).on("line", (line) => {
    if (line.includes(".SettingChanged ('org.freedesktop.appearance', 'color-scheme',")) {
      generation++;
      apply(line);
    } else if (line.includes(destination + " does not have an owner")) {
      if (observed) {
        generation++;
        update("system");
      }

      observed = true;
    } else if (line.includes(destination + " is owned by")) {
      if (observed) void read();
      observed = true;
    }
  });

  function read() {
    const current = ++generation;

    return new Promise((resolve) => {
      execFile("gdbus", ["call", "--session", "--dest", destination, "--object-path", portalPath,
        "--method", "org.freedesktop.portal.Settings.Read", appearance, "color-scheme"], { timeout: 1000 },
      (error, output) => {
        if (!error && current === generation) apply(output);
        resolve(undefined);
      });
    });
  }

  return read();
}

/** @param {(event: import("electron").IpcMainInvokeEvent) => boolean} allowed */
export async function startAppearance(allowed) {
  const path = join(app.getPath("userData"), "appearance");
  const saved = await readFile(path, "utf8").catch(() => "");
  let choice = /** @type {Theme} */ (isTheme(saved) ? saved : "system");
  let system = /** @type {Theme} */ ("system");
  const apply = () => { nativeTheme.themeSource = choice === "system" ? system : choice; };

  apply();
  await watchLinuxAppearance((theme) => { system = theme; apply(); });

  ipcMain.handle("pulse:appearance:get", (event) => {
    if (!allowed(event)) throw new Error("Appearance is only available in the dashboard");

    return choice;
  });

  let saving = false;
  ipcMain.handle("pulse:appearance:set", async (event, value) => {
    if (!allowed(event) || !isTheme(value) || saving) throw new Error("Cannot set appearance");

    saving = true;

    try {
      await writeFile(path + ".tmp", value, { mode: 0o600 });
      await rename(path + ".tmp", path);
      choice = value;
      apply();
    } finally {
      saving = false;
    }
  });
}
