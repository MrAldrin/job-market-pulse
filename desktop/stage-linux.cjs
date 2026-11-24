const { chmod, copyFile, rename } = require("node:fs/promises");
const { join } = require("node:path");

module.exports = async ({ appOutDir }) => {
  // AppRun invokes this entry point. Route CLI calls before Electron tries to
  // connect to a display, so the same AppImage works in a plain terminal.
  const entry = join(appOutDir, "job-market-pulse");
  await rename(entry, `${entry}-electron`);
  await copyFile(join(__dirname, "appimage-launcher.sh"), entry);
  await chmod(entry, 0o755);
};
