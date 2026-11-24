#!/usr/bin/env bash
set -euo pipefail

if [[ $OSTYPE != linux* || $EUID == 0 ]]; then
  echo 'Run the smoke test on Linux as a non-root user.' >&2
  exit 1
fi

# The temporary workspace shares history, not builds, dependencies or local data.
cd "$(jj root)"
bun=$(realpath "$(command -v bun)")
node=$(realpath "$(command -v node)")
cache=$(realpath "${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}")
case $(uname -m) in
  x86_64) archive=electron-v45.4.1-linux-x64.zip ;;
  aarch64) archive=electron-v45.4.1-linux-arm64.zip ;;
  *) echo 'Smoke needs a supported Linux Electron architecture.' >&2; exit 1 ;;
esac
if [[ -v PULSE_SMOKE_ELECTRON_ZIP ]]; then
  zip=$(realpath "$PULSE_SMOKE_ELECTRON_ZIP")
else
  zip=$(find "${XDG_CACHE_HOME:-$HOME/.cache}/electron" -name "$archive" -type f -print -quit)
fi
[[ -f $zip && -d $cache ]] || { echo "Smoke needs the local Bun cache and $archive." >&2; exit 1; }
zip=$(realpath "$zip")

scratch=$(mktemp -d /tmp/pulse-smoke.XXXXXXXX)
workspace=${scratch##*/}
registered=0
cleanup() {
  if (( registered )); then
    jj --no-pager workspace forget "$workspace" || { echo "Could not forget $workspace; kept $scratch." >&2; return 1; }
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
jj --no-pager workspace add --name "$workspace" -r @ "$scratch/checkout"
registered=1
mkdir "$scratch/home" "$scratch/tmp"

# If isolation fails, do not install, build or launch anything. The PID namespace
# also stops detached app children if the test times out or the runner stops.
env -i PATH="$(dirname "$node"):$(dirname "$bun"):/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$scratch/home" TMPDIR="$scratch/tmp" XDG_DATA_HOME="$scratch/home/data" PULSE_SMOKE_NODE="$node" \
  DEBUG="${PULSE_SMOKE_DEBUG:+pw:browser}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$scratch/no-bus" DBUS_SYSTEM_BUS_ADDRESS="unix:path=$scratch/no-bus" \
  timeout --kill-after=10s 5m unshare --map-current-user --keep-caps --net --pid --fork --kill-child --mount-proc \
  bash -euc 'ip link set lo up; exec setpriv --ambient-caps=-all --inh-caps=-all "$@"' bash \
  bash -euo pipefail -c '
    cd "$1/checkout"
    bun=$2
    version=$("$bun" --no-env-file -p "require(\"./package.json\").engines.bun")
    [[ $("$bun" --version) == "$version" ]] || { echo "Smoke needs Bun $version." >&2; exit 1; }
    "$bun" --no-env-file install --offline --frozen-lockfile --ignore-scripts --cache-dir="$3"
    checksum=$("$bun" --no-env-file -p "require(\"electron/checksums.json\")[\"$5\"]")
    printf "%s  %s\n" "$checksum" "$4" | sha256sum --check
    unzip -q "$4" -d node_modules/electron/dist
    "$bun" --no-env-file run build
    "$bun" --no-env-file --bun node_modules/@playwright/test/cli.js test --config playwright.smoke.config.ts --global-timeout=120000
  ' bash "$scratch" "$bun" "$cache" "$zip" "$archive"
