#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'Build the Linux AppImage on Linux.' >&2
  exit 1
fi

stage=local_only/package-linux
assets="$stage/resources"
mkdir -p "$stage/app" "$assets/contracts/fixtures" "$assets/skills/pulse-interview"

bun run setup:desktop
PULSE_BUILD_APPIMAGE=1 bun run build
install -m 755 "$stage/dashboard/server" "$assets/pulse-dashboard"
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli/pulse.ts --outfile "$assets/pulse"
bun build --target bun src/lib/server/judge/harness-readiness-supervisor.ts --outfile "$assets/pulse-probe.mjs"

# Copy only the shipped inputs. Never package a checkout or user state.
mkdir -p "$assets/config"
install -m 644 config/area_extents.json config/market_taxonomy.toml config/occupation_categories.toml config/title_exclusions.neutral.toml "$assets/config/"
install -m 644 skills/pulse-interview/questions.toml skills/pulse-interview/profile-template.md "$assets/skills/pulse-interview/"
install -m 644 contracts/fixtures/snapshot.example.json "$assets/contracts/fixtures/"
install -m 644 desktop/main.mjs desktop/appearance.mjs desktop/appearance-preload.cjs "$stage/app/"
install -D -m 644 desktop/icons/icon-512.png "$stage/app/icons/icon-512.png"
bun --no-env-file -e '
  const { name, version } = await Bun.file("package.json").json();
  await Bun.write("local_only/package-linux/app/package.json", JSON.stringify({
    name, version, type: "module", main: "main.mjs", author: "Job Market Pulse",
    description: "Review saved job-market matches", desktopName: "job-market-pulse.desktop",
  }));
'
electron-builder --config desktop/electron-builder-linux.yml --linux AppImage --publish never
