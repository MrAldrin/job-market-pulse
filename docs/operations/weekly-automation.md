# Scheduled refresh

## Timer commands

The scheduler commands have offline tests with fake executors. No live timer
or task was verified on any platform. Enabling a schedule needs separate owner approval
under [scope](../scope.md).

Put `--root PATH --profile PROFILE` before `schedule` or `run-scheduled`.

- `pulse schedule install` checks profile and tool readiness and previews the
  definition. Type `yes` to register and enable it.
- `pulse schedule status` inspects the selected profile's schedule.
- `pulse schedule remove` requires typed `yes` before removal.
- `pulse schedule run-now` requires typed `yes` before it requests a run of the
  installed definition. The request does not prove a refresh completed. It can
  start live source reads, model calls and an upload if configured.

Installation reads `[schedule] schedule` in the profile's `profile.toml` or
uses the existing weekly or fortnightly cadence. A saved
`schedule = "never"` disables schedule resolution instead of using weekly.
The setup schedule step plans this table without installing a timer. It saves
the full day/time expression and an interval anchor. A changed interval or
weekday gets a new anchor; a time-only edit keeps its existing interval anchor.
Saved profile clocks use `16:00`. Setup shows the explicit install command for
an enabled schedule.
A saved `[schedule]` anchor preserves an interval's start date. Without that
key, the existing cadence anchor is the runtime fallback for any interval.
Setup retains that known phase on a time-only edit if it is valid for the
interval and weekday; an invalid fallback stops the edit without a write.
Setup keeps an unanchored saved interval unchanged on Enter. Its phase is unknown.
Save an interval anchor before installation.

### Linux: systemd user timer

Install writes the two previewed units. Status checks for unit files and reads
next/last times from systemd when available. The timer service passes the anchor
and `--only-if-due` for intervals, even when started with `schedule run-now`.
Europe/Oslo is explicit in `OnCalendar`, independent of the host time zone. Calendar times precede a
random delay of up to 300 seconds; persistent timers can catch up after downtime.
Before install or run-now, the preview states what [ntfy](../alert/delivery.md#ntfy-phone-notifications)
can send if you turn on notifications.

Unit names include the profile ID and an eight-character hash of the resolved
checkout path. Files go to `$XDG_CONFIG_HOME/systemd/user`, or
`~/.config/systemd/user` when unset. There is no sudo or system-wide install.
Existing units must be removed before replacement. Failed installation attempts
remove files written by that attempt and try to disable the timer and reload.
If rollback fails, the command reports that manual user-systemd checks are needed.
Removal disables and stops the timer, deletes only its two unit files, then
reloads user systemd. It stops before file deletion if disabling fails. A reload
failure after removal does not prove that systemd accepted the change.

### macOS: launchd user agent

Pulse writes a per-checkout, per-profile plist in `~/Library/LaunchAgents` and
loads it in the current graphical login domain. Status does not report run
times. Do not use sudo. Use Claude Code for all active review steps. The
refresh lock requires Bun's native flock binding on Apple silicon or Intel Mac.
If the binding is unavailable, refresh stops before the pipeline starts.

launchd uses the Mac's local time, not an explicit Europe/Oslo time zone.
Use a Mac already set to Oslo time if the profile time must match Oslo.
Interval schedules still check the anchor and due date in Europe/Oslo.
Do not rely on a catch-up run after logout or shutdown. If loading does not
confirm success, the plist remains and could load at the next login. Check
status and remove it before you retry or log in again. If registration is
unknown or unloading fails, Pulse keeps the plist.

`run-now` checks the loaded plist path, executable, arguments, working directory
and job-defined environment before and after confirmation. That environment
must contain only the `PATH` that Pulse would use for a new install from the
current shell. If the action changed, remove the old agent before you install
its replacement. Pulse refuses to start the agent if it cannot verify the
action in the launchd status output.

See the [macOS setup check](macos-setup.md). Native operation is not verified.

### Windows: Task Scheduler

The Task Scheduler adapter has offline tests only. It supports
`schedule install`, `schedule status`, `schedule run-now` and `schedule remove`.
Run `pulse.exe` directly from its installed location, or use the checkout CLI
that owns the task. Supply the same explicit `--root` and `--profile` for each
command. Install and run-now require explicit confirmation. Install also checks
native tool availability and the private Judge storage required for [Windows refresh](short-cli.md#windows-refresh-and-failure-reports).
Before it writes the task XML, Pulse checks that the Windows temporary directory
and the new staging directory have private NTFS permissions and safe inheritance.
If either check fails, Pulse does not register the task. A scheduled run verifies
private NTFS permissions before it opens its history file.

The task runs only while the selected user is signed in. Its calendar trigger
uses the Windows local clock, which must follow Norway time. Status reports
whether the task is registered, but does not report run times. Pulse checks the
registered action and user before run-now or removal. If they do not match,
inspect the task in Task Scheduler.

Remove any earlier Pulse task before uninstalling or replacing Pulse. The
uninstaller does not change tasks. An old task could run again if a later
installation puts a compatible executable at the same path.

## Scheduled refresh

`pulse --root PATH --profile PROFILE_ID run-scheduled [--only-if-due]` runs the existing
refresh path without prompts: source sync, locations, configured personal review,
and local snapshot capture. It uploads only if configured. If the owner opts in, [ntfy notifications](../alert/delivery.md#ntfy-phone-notifications)
can report new exceptional matches or an attempt failure. Use this command only
within an approved scheduled workflow. Timer enablement remains a separate owner action.

- The installation lock stays held through pipeline work, retry waits,
  private snapshot export, upload and the final record. Weekly and profile locks
  retain their existing pipeline scopes. Manual snapshot writers still have
  different lock scopes; do not run them at the same time.
- `--only-if-due` checks today's date in Europe/Oslo. A date that is not
  due exits `0` silently and writes nothing. It is a date check, not a catch-up
  queue or a once-per-date delivery record. A repeated invocation can run again.
- `--period TEXT --anchor YYYY-MM-DD` accepts the fixed interval emitted by the
  unit renderer. Otherwise the profile schedule/cadence is used. Interval due
  checks need a saved or explicit anchor; they refuse an unanchored interval
  instead of moving its start date on each call. Calendar schedules need no anchor.
  Persistent interval timers only run if the catch-up date itself is due.
- You do not need a volume or the Railway CLI for local scheduled refresh.
  To enable scheduled upload, set up `local_only/publish.toml` with a volume.
  If the file is absent or the volume is unset, the timer keeps the snapshot
  local. If upload is configured, the Railway CLI must be on the timer's PATH
  and credentials must already work unattended. Upload takes no terminal input
  and stops after ten minutes.
- Only a pipeline with one verified completion ID can export and upload. A
  failed, waiting, exhausted or ambiguous pipeline uploads nothing. Upload failure
  makes the scheduled run fail; it does not prove whether a remote write occurred.
  Refresh does not fetch feedback. V4 and later also require the
  [private-input opt-in](phone-snapshots.md#settings-snapshot-compatibility).
- Existing pipeline resume and retry rules apply. A stopped failed/exhausted
  pipeline is not reset automatically. Inspect its private reason and use the
  existing owner-started recovery procedure before the next scheduled attempt.

Each actual attempt adds one row to the profile's `scheduled-runs.sqlite3`.
The directory is owner-only (`0700`); the store is `0600`. Rows contain start/end
UTC times, `ok`/`failed`, a failed stage and a short fixed error. An unfinished row
stays `running`, not successful, if the process is killed before it can finish.
A busy installation lock records a failure and exits `75` without pipeline work.
`pulse status` reports the last local pipeline run, not timer history. Snapshot
v1 has no field for the last good scheduled date.

See [scope](../scope.md#operator-consent) for the conditions for scheduled
model calls and snapshot upload. Offline tests use fake
stages and uploads. They do not verify credentials, remote persistence,
unattended model access, a real run, an installed timer or notification delivery.

## Retired weekly planner

The separate weekly history planner and runner are not available. Use the timer commands above for scheduled refresh, only after owner approval.
