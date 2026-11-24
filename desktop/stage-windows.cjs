const { readdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

module.exports = async ({ appOutDir, outDir }) => {
  // List exact installed paths. The uninstaller must not recursively delete
  // the installation directory or touch the separate user data directories.
  const checks = [];
  const commands = [];

  async function list(dir, prefix = "") {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!/^[\w .-]+$/.test(entry.name)) throw new Error("Unsupported Windows payload name: " + entry.name);
      const relative = prefix + "\\" + entry.name;

      if (entry.isDirectory()) {
        checks.push('  !insertmacro CheckPlainDirectory "$INSTDIR' + relative + '" 0');
        await list(join(dir, entry.name), relative);
        commands.push('  RMDir "$INSTDIR' + relative + '"');
      } else if (entry.isFile()) {
        const path = '"$INSTDIR' + relative + '"';
        commands.push("  IfFileExists " + path + " 0 +4", "  ClearErrors", "  Delete " + path, "  IfErrors uninstall_failed");
      } else {
        throw new Error("Unexpected Windows payload entry: " + entry.name);
      }
    }
  }

  await list(appOutDir);
  await writeFile(join(outDir, "uninstall-files.nsh"), [
    "!macro CheckPayloadDirectories", ...checks, "!macroend",
    "!macro RemovePayloadFiles", ...commands, "!macroend", "",
  ].join("\n"));
};
