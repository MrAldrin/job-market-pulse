#!/bin/sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
unset BUN_BE_BUN ELECTRON_RUN_AS_NODE

# electron-builder can prepend this flag. It belongs to Electron, not Pulse.
if [ "${1-}" = --no-sandbox ] && [ "${2-}" = cli ]; then shift; fi
if [ "${1-}" = cli ]; then
  shift
  export PULSE_RESOURCE_ROOT="$here/resources"
  exec "$here/resources/pulse" "$@"
fi

exec "$here/job-market-pulse-electron" "$@"
