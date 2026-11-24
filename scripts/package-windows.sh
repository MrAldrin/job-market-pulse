#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'Build the Windows installer on Linux.' >&2
  exit 1
fi

stage=local_only/package-windows
assets="$stage/resources"
mkdir -p "$stage/app" "$assets/config" "$assets/contracts/fixtures" "$assets/skills/pulse-interview"

PULSE_BUILD_WINDOWS=1 bun run build
install -m 755 "$stage/dashboard/server.exe" "$assets/pulse-dashboard.exe"
bun build --compile --target=bun-windows-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli/pulse.ts --outfile "$assets/pulse.exe"

# Stage explicit project files only. Do not include a checkout or user state.
install -m 644 config/area_extents.json config/market_taxonomy.toml config/occupation_categories.toml config/title_exclusions.neutral.toml "$assets/config/"
install -m 644 skills/pulse-interview/questions.toml skills/pulse-interview/profile-template.md "$assets/skills/pulse-interview/"
install -m 644 contracts/fixtures/snapshot.example.json "$assets/contracts/fixtures/"
install -m 644 desktop/main.mjs desktop/appearance.mjs desktop/appearance-preload.cjs "$stage/app/"
install -D -m 644 desktop/icons/icon-512.png "$stage/app/icons/icon-512.png"
bun --no-env-file -e '
  const { name, version } = await Bun.file("package.json").json();
  await Bun.write("local_only/package-windows/app/package.json", JSON.stringify({
    name, version, type: "module", main: "main.mjs", author: "Job Market Pulse",
    description: "Review saved job-market matches",
  }));
'
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --config desktop/electron-builder-windows.yml --win nsis --x64 --publish never
