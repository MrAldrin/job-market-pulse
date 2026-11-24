# Set up Pulse on macOS

Use a checkout and a web browser. Pulse has no macOS app. The launchd adapter
has offline tests only. These steps are for a separate check on a Mac.

## Prepare the checkout

1. In a terminal in your macOS graphical login, install Git and Bun **1.4.4**.
   Verify them with `git --version` and `bun --version`.
2. Install Claude Code for your user and sign in. Use Claude Code for screen,
   judge and any active re-judge step. A successful Doctor check finds the
   executable but does not test sign-in or model access.
3. Open the Pulse checkout. Run `bun install --frozen-lockfile`, then
   `bun src/cli/pulse.ts doctor`. Before setup, Doctor can report a missing
   profile. The scheduler check should report that the launchd login domain is
   reachable. Do not use `sudo`.
4. Run `bun src/cli/pulse.ts init` and follow the prompts. Keep private settings
   in ignored files. If a model probe or guided profile interview fails, use the
   [manual setup steps](../quickstart.md). Refresh refuses Pi for active review
   steps on macOS before it reads live sources. Pi readiness requires Linux.
   Run Doctor again after you select and configure the profile.

## Check the browser dashboard

Run `bun run build` and `bun src/cli/pulse.ts demo`. Open the loopback URL in
your browser. Verify that invented jobs are visible, then press Ctrl+C.
This check does not start a refresh or use credentials.

When the selected profile has a saved snapshot, run
`bun src/cli/pulse.ts dashboard`. Open the printed loopback URL and check that
it shows the selected profile. The dashboard does not create a snapshot when
it opens. Do not start a live refresh as part of the demo check.

## Check scheduler status

Start with `schedule status`. Use this command form from the checkout, and
replace `PROFILE` with your profile ID:

```bash
bun src/cli/pulse.ts --root "$PWD" --profile PROFILE schedule status
```

- On a new checkout, check that the agent is not installed. Status does not
  start a refresh.
- A passing Doctor scheduler check only confirms that the graphical login
  domain responds. With separate owner approval, check the profile, Claude Code
  settings before installation. If you configure scheduled upload, also check
  unattended Railway access and the upload settings.
- Run the same command with `schedule install`. Inspect the plist preview, the
  local time and the actions before you type `yes`. Check that status reports
  `installed: True`.
- `schedule run-now` is not a dry run. Use it only as part of an approved live
  check. Verify the saved run separately; a start request is not a result.
- Run `schedule remove` and confirm removal. Check that status reports
  `installed: False` and `partial: False` without an error.

See [scheduled refresh](weekly-automation.md#macos-launchd-user-agent) for
local time, interval and recovery limits.
