export const syntheticProbePrefix = "pulse-synthetic-executable-";

export const syntheticPi = `#!/bin/sh
printf invoked > "$PATH/invocation-marker" || exit 8
[ "$#" = 8 ] && [ "$*" = 'auth check --provider invented --model small --json --no-refresh' ] || exit 3
[ "$PWD" != "$PATH" ] || exit 4
for entry in .[!.]* ..?* *; do
  [ ! -e "$entry" ] || exit 5
done
if read -r input; then exit 6; fi
printf '%s' "$PWD" > "$PATH/probe-directory" || exit 7
printf '%s\\n' 'synthetic stderr, not returned' >&2
printf '%s\\n' '{"status":"ready"}'
`;
