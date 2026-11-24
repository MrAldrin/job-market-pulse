# Pulse CLI

## One-time setup

Check the [Bun and Node.js prerequisites](../quickstart.md#set-up-your-profile)
before you install dependencies. From this checkout:

```bash
bun install --frozen-lockfile
bun link
bun pm bin -g
```

`bun link` registers `pulse` in Bun's global bin directory. Run it from the
checkout you intend to keep. The launcher stops working if you move or remove
that checkout.

The last command prints the active global bin directory. Add that directory
to `PATH` in the current shell. In Bash, run:

```bash
export PATH="$(bun pm bin -g):$PATH"
pulse --help
```

In fish, run:

```fish
fish_add_path --path --move (bun pm bin -g)
pulse --help
```

If `pulse --help` reports a Python import error or opens the wrong checkout,
run `type -a pulse` in Bash or fish to list the launchers in resolution order.
A retired launcher can be a Python entry point in `.venv/bin/pulse` or a wrapper
in `~/.local/bin/pulse` that calls `uv run ... pulse`. Inspect the files before
moving them. Move only confirmed retired launchers to unused backup names so
that they no longer take precedence on `PATH`. Run `type -a pulse` again, also
with the virtual environment active if you use one.

To use the CLI without changing any launcher, run
`bun src/cli/pulse.ts --help` from the checkout. Run `bun run build` before using
the dashboard or demo. See [scope](../scope.md) for the separate approvals for
live operation and timer installation.

## Check setup

`bun run setup` runs Doctor before it starts the setup wizard. To run Doctor
separately, use `pulse doctor` or `bun src/cli/pulse.ts doctor` after you install
the locked dependencies. Check the pinned Bun version first if Bun cannot run.

Doctor checks the pinned Bun version and Git. In a checkout, it also checks
that `node` on `PATH` is Node.js 22.17 or newer. Packaged apps do not use this
checkout Node.js check. It looks on `PATH` for Pi or
Claude Code on Linux, Claude Code on macOS, and native `claude.exe` on Windows.
A Windows `.cmd` wrapper does not pass this check.

Doctor checks the selected profile and writable data directories. Profile checks that
need a valid selection or policy wait until that setup is in place. For a data
directory that does not exist yet, Doctor tests the nearest existing parent.
It creates and removes a temporary file for each write test. It does not open
existing databases for writes or need a populated Source database.

Doctor makes a read-only scheduler query: user systemd on Linux, the launchd
login domain on macOS, or Task Scheduler on Windows. It does not install or
start a schedule. A successful query does not mean Pulse can schedule a run on
that platform. The harness check does not verify sign-in or call a model.
Doctor does not run a refresh or contact a delivery service.

The ntfy topic check is optional and reports presence only. It does not test
delivery or report whether automatic notifications are on. For a Linux checkout,
Doctor also checks whether the app menu entry points to the current Bun and
checkout. A missing or outdated entry is optional. Doctor also reports a
missing or stale checkout dashboard build. This check is optional because
terminal refresh and other non-dashboard commands do not need a build.

Use `pulse doctor --json` for the [versioned report](../../contracts/doctor.schema.json).
The exit status is `0` when all required checks pass, `1` when a required
check fails, and `2` for invalid command use. Read fixes in `checks[].fix`.
Optional checks do not change the exit status.

## Daily commands

Put `--root PATH` and `--profile ID` before the command. The root defaults to
this checkout. For selected-profile commands, `local_only/pulse.toml` in that
root supplies the default profile. Timer commands require both selectors to be
explicit. `pulse init --root PATH` also accepts its own root option.

| Command | Result |
| --- | --- |
| `pulse doctor` | Check local setup requirements and show fixes. Use `--json` for a coding agent. |
| `pulse init` | Set up a profile, including the interview, reviewer settings and schedule plan. Confirm before saving changes. |
| `pulse init --step alert` | Configure [ntfy notifications](../alert/delivery.md#ntfy-phone-notifications) in a terminal. Does not send a test. |
| `pulse refresh` | Run the local pipeline. Upload the new snapshot only if configured. |
| `pulse refresh --no-publish` | Run the same pipeline without uploading. |
| `pulse re-review --all` or `pulse re-review --listings ID[,ID...]` | [Reconsider eligible jobs with older decisions](../review/hand-run-review.md#saved-state-and-reuse) and capture the result locally. |
| `pulse status` | Read the selected profile, last local run and saved snapshot. Report setup notes and warnings on stderr. This does not check remote publication. |
| `pulse dashboard` | Open the selected profile's dashboard on loopback. |
| `pulse desktop` | Open the local dashboard in a [Linux desktop window](#linux-desktop-window). |
| `pulse publish` | Preview an upload of the newest saved snapshot. Use `--apply` and type `y` to upload after approval. `--yes` skips the prompt, not approval. |
| `pulse schedule install`, `pulse schedule status`, `pulse schedule remove`, `pulse schedule run-now` | Manage this profile's [schedule](weekly-automation.md#timer-commands). Changes and immediate runs require typed confirmation. |
| `pulse run-scheduled` | Run the scheduler's refresh workflow. Linux interval timers supply the due-check arguments. |
| `pulse demo` | Serve invented jobs on loopback. No profile, network service, or feedback store is needed. |
| `pulse sqlite_backup --db FILE --output FILE` | Create a private SQLite backup. The output directory must exist. The command does not replace an existing file. |

See `pulse COMMAND --help` for options. Place help after the command path, with
no command options. For guided setup, see the [setup wizard](setup-wizard.md).
The checkout detects installed harnesses but does not query their model lists.
Enter the model and effort explicitly when setup has no saved choice.

## Refresh, publish and timers

Refresh does not fetch feedback. Failed or incomplete runs upload nothing.
Opt-in [ntfy notifications](../alert/delivery.md#ntfy-phone-notifications) are separate from upload.

Upload uses the Railway CLI in the selected root. Set the
[upload destination](phone-snapshots.md#settings-snapshot-compatibility)
in `publish.toml`. For v1–v3, link the intended Railway project separately.
A manual v1–v3 upload can ask for a volume. A timer needs a volume only to upload.
Installation checks for the configured review programs. It checks for Railway
on the timer's PATH only if scheduled upload is configured. Reinstall the timer if these paths
change. `pulse init` saves schedule settings but does not enable a timer.
Installation prints the proposed unit files before asking for confirmation.

## Local Svelte dashboard

`pulse dashboard` serves `dashboard-snapshot.json` for the selected profile. It
does not start a refresh on open or fall back to another profile or database.
The checkout dashboard and desktop refuse a missing or stale build. Run
`bun run build` from the checkout root and open the app again. The build
compares source, static assets, resources, build configuration and the lockfile
by content, not by modification time. The build does not follow symbolic
links in its inputs. Replace any link that the build reports with a regular file
or directory before you rebuild. Packaged apps do not use this check.
Use [Run](../dashboard/new-dashboard.md#local-refresh-server) in the writable
local dashboard to refresh without uploading. The default
address is `http://127.0.0.1:8770/`; use `--port` to change it. Stop it with Ctrl-C.

Feedback uses the selected profile's separate SQLite store. The [local settings
editor](../dashboard/new-dashboard.md#current-local-settings) uses private TOML
files. Use `--read-only` to disable both. `--snapshot FILE` reads an explicit saved snapshot in read-only
mode and does not select a profile. The demo serves a read-only snapshot with fresh dates from the shipped
synthetic fixture. Dashboard and demo do not load `.env` or inherit hosted credentials.
Use both `--serve-origin` and `--serve-owner` to opt in for a writable profile.
See the [private phone setup](../dashboard/phone-view.md#open-the-local-dashboard-through-tailscale-serve).

## Linux desktop window

### Use the AppImage

Keep `JobMarketPulse.AppImage` in a folder you can access. In that folder, run:

```bash
chmod +x JobMarketPulse.AppImage
./JobMarketPulse.AppImage
```

The AppImage includes Pulse and the dashboard. It does not need Bun, Git or a
checkout. The first-run page shows the `cli init` command for your AppImage.
Use `cli status` to check setup. Model review needs a separate installation
and sign-in for Pi or Claude Code. Follow the [setup guide](setup-wizard.md).
When you are ready to run the live pipeline, open the app and select **Run**.
You can also use `./JobMarketPulse.AppImage cli refresh --no-publish`. To view invented jobs without setup, run
`./JobMarketPulse.AppImage --demo`. If FUSE is unavailable, put
`--appimage-extract-and-run` before `--demo` or `cli`.

The app stores installation settings in `$XDG_CONFIG_HOME/job-market-pulse`
and profiles and run data in `$XDG_DATA_HOME/job-market-pulse`. The defaults are
`~/.config/job-market-pulse` and `~/.local/share/job-market-pulse`. Replacing the
AppImage does not replace these files. AppImage timer installation is not
supported. `cli` commands do not need a graphical session. The window needs a
Linux graphical session that supports the Chromium sandbox.

### Build the AppImage

From a Linux checkout, use the pinned Bun version:

```bash
bun install --frozen-lockfile
bun run package:linux
bun run test:appimage
```

The build can download the pinned Electron runtime and AppImage tools. It
writes `local_only/package-linux/output/JobMarketPulse.AppImage` for the build
machine's architecture. It does not publish or install the image. The smoke
test needs a graphical session. It uses an isolated home and invented data.
It does not verify live refresh, a model login or a timer.

The logo has one source: `desktop/icons/icon.svg`. After you change it, run
`bun run icons`. The script makes the PNG files for the AppImage, the window and
the Linux menu launcher. It also makes the dashboard and docs favicons and the
GitHub social preview, `desktop/icons/social-preview.png`. It uses the pinned
Playwright Chromium (`bun run setup:browser`). The Windows `.exe` keeps the
default Electron icon, because the build does not edit the executable.

### Run from the checkout

First run `bun install --frozen-lockfile`. Then run:

```bash
bun run setup:desktop
bun run build
bun run desktop
```

Setup downloads the pinned Electron runtime for your Linux system. Startup
does not download it. Use a Linux graphical session that can run Electron
with its sandbox enabled.

`bun run desktop` opens the selected profile, as does `pulse desktop`. To view
only a saved snapshot, run `bun run desktop --snapshot FILE`. To select a
different installation or profile, put `--root PATH` and `--profile ID`
before `desktop` in the Pulse CLI. You can also use `--read-only`.

To add Job Market Pulse to the app menu, use `pulse desktop install-launcher`.
If `pulse` is not on `PATH`, use `bun src/cli/pulse.ts desktop install-launcher`
from the checkout. Full interactive `pulse init` also offers this step on Linux.
If you answer yes, the wizard sets up the pinned Electron runtime before it
writes the entry. Press Enter to skip this step.

The menu opens the dashboard for the selected profile. If no snapshot exists,
Home shows an empty state. Select **Run** to get your first jobs.
Before your first refresh, you can [try the dashboard demo](../quickstart.md#try-the-dashboard)
in your browser. The demo does not create a snapshot for your profile.

The command writes `job-market-pulse.desktop` in `$XDG_DATA_HOME/applications`
(default: `~/.local/share/applications`). It uses the current Bun and checkout
paths. The entry sets its own `PATH` from the Bun and harness directories,
Node for harness scripts that use `env node`, and standard system directories.
For fnm, it saves the installation directory instead of the temporary shell path.
Install it from a shell where the configured harnesses work. Run the install
command again after a tool moves or changes its runtime. Doctor checks whether
the configured harnesses can report their versions with the saved `PATH`.
Use `pulse desktop remove-launcher` to remove the entry. Neither command
installs Electron or builds the dashboard.
If the menu entry does not open, run `bun run desktop` to see the error.

The window uses a free loopback port. Web links outside the dashboard open
in your system browser. A second launch focuses the existing window. Closing
it stops its local server. The app asks before closing if a dashboard refresh
is running or waiting to retry. The server refuses new dashboard refreshes
while the app closes or waits for your answer. Select **Keep open** to allow
new runs again. Idle and read-only windows close without confirmation.
If the app cannot check for a refresh, **Keep open** is the default.
Select **Close anyway** to stop the local server and quit.
Closing does not upload anything. The CLI asks the server
to stop and gives it time to finish cleanup before a forced stop. The window
waits for the CLI to exit, not for its output streams to close.

Run `bun run test:desktop` in a Linux graphical session with Electron installed.
On Linux, `bun run test:desktop-shutdown` checks the real CLI and server
without a graphical session. Both tests use invented data, not a live refresh.

## Windows desktop installer

From a Linux checkout, use the pinned Bun version:

```bash
bun install --frozen-lockfile
bun run package:windows
```

The build can download the pinned Windows Bun and Electron runtimes and
the Linux NSIS compiler. It writes
`local_only/package-windows/output/JobMarketPulse-Setup-x64.exe`. It does
not execute Windows binaries or publish anything.

The installer is for x64 Windows and is not signed. SmartScreen can warn.
Verify the SHA-256 against the checksum supplied with the build before you
run it. Do not use the superseded installer from build `0079b4c4`.
The installer needs no administrator rights. It does not start the app or
register it in Start or Windows Settings. Open `Job Market Pulse.exe` in
`%LOCALAPPDATA%\Programs\Job Market Pulse`.

To replace this build, close Pulse and run `Uninstall.exe` from that folder.
If a Pulse task was registered earlier, [remove it before uninstalling](weekly-automation.md#windows-task-scheduler).
The installer refuses to overwrite an existing installation folder.
The uninstaller removes only the listed app files. It keeps Pulse settings and
data, and it does not touch shortcuts or Windows uninstall registration.

### Offline owner checklist

Use a clean local Windows test account and disconnect it from the network.
Do not run a refresh, a model check, an upload or a scheduled task.

1. Install the verified file. Open `Job Market Pulse.exe` from the installation
   folder. Check
   that the first-run page shows a PowerShell setup command for the installed
   `resources\pulse.exe`. Close the window.
2. In PowerShell, use the installed executables directly. The first status
   should report that no profile is selected. Check that it points into
   `%APPDATA%\job-market-pulse`, not the checkout. Run only the profile step
   of setup. Use an invented ID such as `windows-smoke` and confirm the save.
   Run status again. Incomplete setup is expected.

   ```powershell
   $app = Join-Path $env:LOCALAPPDATA 'Programs\Job Market Pulse'
   $cli = Join-Path $app 'resources\pulse.exe'
   Remove-Item Env:PULSE_RESOURCE_ROOT -ErrorAction SilentlyContinue
   & $cli status
   & $cli init --step profile
   & $cli status
   ```

   User settings belong in `%APPDATA%\job-market-pulse`. Profiles and run
   data belong in `%LOCALAPPDATA%\job-market-pulse`. Do not supply a resource
   path override: the direct CLI must find its resources beside the executable.
3. Run `& (Join-Path $app 'Job Market Pulse.exe') --demo`. Check that the
   window shows invented jobs. Close the window. In Task Manager, check that
   Pulse and its dashboard server exit. To check saved display, run the
   following command, open the printed loopback URL, then stop it with Ctrl+C.

   ```powershell
   $sample = Join-Path $app 'resources\contracts\fixtures\snapshot.example.json'
   & $cli dashboard --snapshot $sample --read-only
   ```

4. Check that `$cli` is an absolute path to the installed `pulse.exe`. It is
   the executable that the Task Scheduler adapter selects in installed mode.
   The direct status check above must work without Bun on PATH, Electron or
   `PULSE_RESOURCE_ROOT`. Fake executor tests verify that the adapter uses
   `--root "<absolute installation root>" --profile "<id>" run-scheduled`.
   Do not register, inspect or run a task for this checklist. The native task
   definition, registration and scheduled runs remain unverified.
5. With Pulse closed, run the installer again. Check that it refuses to
   overwrite the existing folder. Run `Uninstall.exe` from the installation
   folder. Check that the executable is gone and the test profile files remain.
6. In the test account only, use disposable fixtures for a Start shortcut and
   a per-user uninstall registry entry with the product name and old key
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\no.jobmarketpulse.desktop`.
   Check that install and uninstall leave both fixtures unchanged. Also test
   a partial payload: in a fresh test install, remove some payload files but
   keep `Uninstall.exe`. Run it and check that it removes the remaining app
   files without changing the fixtures or the test profile.

Linux checks cover the build and fake scheduler calls. The native installer
and the full `bun run check` workflow on `windows-latest` are unverified.
Some existing tests assume POSIX behavior.

### Windows refresh and failure reports

Windows supports CLI refresh, local dashboard Run and CLI re-review with a
native `claude.exe` on PATH. Each enabled review step must use Claude Code.
Pi refresh readiness and the guided profile interview still require Linux
process supervision. A scheduled upload also needs a native `railway.exe`.
See [Task Scheduler](weekly-automation.md#windows-task-scheduler).

Keep the profile and Judge database on local NTFS storage with private access.
Pulse uses Windows PowerShell without user profiles to check the ACLs. It checks
the directory chain, the database and existing SQLite journals. It refuses to
run if it cannot verify the permissions. Do not loosen the ACL or run as an
administrator to bypass this check.

If an approved test fails:

1. Point a coding agent at the project checkout. Ask it to read this section and
   run `& $cli doctor --json` using the installed CLI from the checklist.
   Doctor checks setup, not model sign-in or Judge database ACLs.
2. Only repeat the approved action. For an approved local refresh test, use
   `& $cli refresh --no-publish` to prevent upload. This command still uses
   live sources and configured models. Do not install or start a scheduled task
   without separate approval.
3. Open the `report.json` named on the `Windows failure report:` line.
   Send the file contents, not the terminal transcript or the path. The file
   has the Pulse and Bun versions, OS version and architecture, operation,
   failed step, a fixed error message and the exit code when available. It has
   no profile text, arguments, credentials or raw error output. Inspect the
   doctor result before you include it. Do not send private data.
4. If Pulse could not save the report or the process was forcibly terminated,
   report that no file was available. A stopped process cannot write a report.

Pulse saves each failure file in a separate folder under the user temporary
directory. It writes no file if it cannot verify that directory's NTFS
permissions. It does not send the file. Delete the folder when you no longer
need it. Native Windows refresh and Task Scheduler acceptance remains a
separate test.

## Snapshot safety

Refresh and publish coordinate through the installation lock. Publish sends only
the newest saved snapshot in a temporary private SQLite file. It does not send
the source, reviews, or feedback database. Do not run direct snapshot writers
while refresh or publish is active. Keep snapshots and SQLite backups private.
The backup omits cached advertisement text when the input has an `ad_texts` table.

## Verification limits

The checkout is tested with invented data. This does not verify a live NAV run,
model login, Railway upload, or active user timer.
