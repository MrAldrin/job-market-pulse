# Local Svelte dashboard

## Implemented status

The TypeScript dashboard is one root SvelteKit app with the pinned Bun adapter.
The same build runs locally or in the Railway image. This is offline
implementation, not a deployment or owner desktop/phone acceptance result.
Captured settings have a separate hosted release gate.

| Page | Behavior |
| --- | --- |
| Home | Saved shortlist in selection order, fit labels, first-found dates and date-based New labels |
| Jobs | Title or employer search, multi-select fit filters, saved-only filter when available, closed ads and sorting |
| Job detail | Saved review, evidence, questions, job facts and source-ad link |
| About | Run counts, review history, job review flow, fit levels, search mode at capture, and snapshot and source check times in Oslo time |
| Market | LayerChart lines and exact counts for separate archived NAV, recorded stock and retained reviewed-job series |
| Salary | Saved monthly median chart, counts and stated pay facts for reviewed jobs |
| Settings | Read-only captured settings; a separate current settings editor for the selected local profile |

The app keeps its hash routes under `/app/`. A direct missing-job link shows an
empty state and a Jobs link. Back uses known app history and restores scroll;
a direct detail link falls back to Jobs. Navigation does not refresh sources,
call a model or select new recommendations. The dashboard follows the device's
light or dark setting. Changes apply without a page reload.

In **Jobs**, select a card to read the saved assessment without leaving the
list. Use **Open job details** for the direct link. Filters stay in the URL.
With no fit boxes selected, all fit levels are eligible. The initial view
excludes Poor. Home and Jobs cards show an approximate straight-line distance
when the snapshot has a verified workplace point. See the [distance contract](../../contracts/snapshot-v6.md)
for the colors and the meaning of **Distance unknown**.

## Build

Run from the checkout root with the pinned Bun version:

```text
bun install --frozen-lockfile
bun run check
bun run build
```

The build goes to ignored `build/`. There is no separate `dashboard/` package,
committed `dist/`, source-digest stamping step or bundled sample snapshot.
See [TypeScript structure](../architecture/bricks.md#typescript-structure) for offline checks.

## Open saved data

After building, run the foreground TypeScript command:

```text
bun src/cli/pulse.ts dashboard --snapshot contracts/fixtures/snapshot.example.json
```

This example uses invented data only. The default address is
`http://127.0.0.1:8770/`. `--port N` changes the loopback port. Stop with Ctrl-C.
An explicit relative snapshot path uses the caller's current directory.
The command name stays `pulse dashboard`, not `pulse serve`.
The root entry point is not a globally installed launcher.

Without `--snapshot`, the CLI opens the selected profile's saved JSON. See the
[CLI guide](../operations/short-cli.md#local-svelte-dashboard). A direct adapter
launch still reads `PULSE_DATA_DIR/digests.sqlite` by default, or a local JSON
file from `PULSE_DASHBOARD_SNAPSHOT`. Hosted mode does not accept that file
override. Opening the app does not capture, upload or modify a snapshot.

## Snapshot boundary

Snapshot owns the Schema, decoder and storage reader in
`src/lib/contracts/snapshot.ts` and `src/lib/server/snapshot/`. The dashboard reads
v1 through v6 documents. The UI receives typed page data, not profile files or
private pipeline tables. Recorded stock counts and coverage need a v2
snapshot with that history. Missing counts and medians do not become zero.
Lines stop at missing readings, absent periods and changes in taxonomy. Use
**Chart period** for an exact reading or **Show values** for its table.

`GET /app/snapshot.json` returns the stored JSON bytes and `X-Digest-Published`
for a database snapshot. The local file override returns validated JSON without
that header. For the database, no saved JSON returns 404. An unreadable or invalid
selected input returns 503. `HEAD` returns the same status and headers without a
body.

Home displays the saved shortlist. Snapshot time is not proof of a fresh source,
a successful run or delivered alerts. **Listing expires** is not an application
deadline. Unknown facts stay unknown. See the
[snapshot contract](../architecture/contracts.md#snapshot-v1-contract) and
[page gaps](page-plan.md#current-contract-gaps).

## About

**How it works** shows the job review flow, not a run log. It shows re-judge
only when the snapshot records selected fit levels. It shows alerts only when
the snapshot records that phone notifications were enabled. Neither setting
proves that a stage ran or a notification was sent.

**This run** uses the same step names. V5 and refresh captures in v6 show how many feed changes Pulse read
and what happened to ads in the saved pool. These are separate counts. The pool
can include ads and compatible reviews from earlier runs. Older snapshots do
not show run counts. **Review history** shows saved open and closed jobs from
any run. The history bar uses blue for open jobs and gray for closed jobs.
The counts below the bar have labels. Select a linked count to see those jobs.

Fit tags and Run stages use the same color rules in light and dark mode.
Green marks high fit (Strong or Exceptional) or a completed stage. Blue marks
active work. Amber marks possible fit or a retry wait. Red marks failure.
Gray marks no fit signal or no new work. The text gives the exact fit or status.

## Appearance

In **Settings**, select **System**, **Light**, or **Dark**. System follows the
desktop or browser color preference. The desktop app remembers the choice
across restarts. A browser remembers it for the current site.

## Captured settings

Open **Settings** at `/app/#/settings`. Local and authenticated hosted viewers
show the same captured inputs for the same snapshot. V4 and later show home location
and the comparison profile as plain text. V3 still shows its settings and
reports that these private inputs were not captured. V1 and v2 report that
settings were not captured. The captured section is read-only and does not
check current configuration or timer status. See the
[settings contract](../architecture/contracts.md#snapshot-v3-settings) and
[release order](../operations/phone-snapshots.md#settings-snapshot-compatibility).

## Current local settings

Open the selected profile with `pulse dashboard`. Under **Settings**, use
**Current local settings** to edit the search mode and review settings.
**Just looking** recommends Exceptional jobs only. **Actively looking** also
recommends Strong jobs. The next run uses the new mode. Saved reviews stay
valid. If phone notifications are enabled, they still alert only for new
Exceptional matches in both modes.

Choose a review step, harness, model and effort to edit the review settings.
For Pi, select **Refresh Pi models** to update the private cached list. The
picker shows the levels that both Pi and the settings file support. It does
not offer new selections that only support reasoning off. Claude Code uses
the Anthropic aliases `opus`, `sonnet` and `haiku`.

Listed models are candidates, not proof of access. **Test this model** makes
one short request with the selected harness. It sends no profile or job text
and does not save the selection. Use **Save model** to save the selection for
that step.

In **Re-judge**, select any first-score levels for a second assessment during
refresh. Clear all levels to turn the pass off. Clear **Same as the Judge model**
to select a separate model. If Pi does not list the model, enter its provider
and model IDs. The job detail shows the second model and keeps the first
score and model under **Repeat review**. See [automatic re-judge](../review/hand-run-review.md#automatic-re-judge-during-refresh).

In **Location**, enter your four-digit home postcode and search radius. Pulse
looks up a new postcode area on save and shows the saved postcode and place.
An unsuccessful lookup leaves the previous location unchanged. The editor
has no manual coordinate fields.

Enter one value per line in list fields. The **Exclusions** card at the bottom
keeps title, employer and municipality exclusions. For an interval schedule,
enter a start date. For a weekly or disabled schedule, leave it blank.

In **Title screening lists**, enter a word or phrase on each line. Add `*`
at the end to match longer words, such as `engineer*`. Simple saved rules
appear as editable terms. **Advanced (read-only)** shows other saved rules.
Saving the terms does not change these advanced rules.

Use **Phone notifications** to change the [ntfy settings](../alert/delivery.md#ntfy-phone-notifications).
The topic field is write-only; the dashboard never returns the saved topic.
Captured settings can show whether notifications were on at capture.

Each save updates one private file. The CLI and pipeline read the same files. Filter edits change which jobs qualify, not the saved reviews of
jobs that still qualify. See [saved state and reuse](../review/hand-run-review.md#saved-state-and-reuse)
for older reviews and the explicit re-review command. Saving does not start a
run, change the snapshot, upload data or change a timer.

The files must exist and pass their normal schema checks. If an individual
section is unavailable, check its file and reload the page. Most TOML saves
can change formatting and remove comments. A search mode save changes only the
mode entry. To edit it in Settings, keep a separate `mode = "passive"` or
`mode = "active"` line under `[policy]` in `profile.toml`. A schedule save
changes only the schedule and cadence entries. If the file changed since you opened it, reload
current settings. If a run holds the installation lock, wait until it ends.

`--read-only`, `--snapshot FILE`, the demo and Railway have no edit controls
or editor access. See the [local settings API](../../contracts/local-settings-api.md).

### AI settings suggestions

The helper buttons state which saved inputs go to the configured Calibration
model. They can suggest a profile edit, a title or employer exclusion, or a
preferred term. **Check exclusions against liked jobs** can suggest removal
when a current literal title or employer rule matches a liked saved job.
This check uses current rules, not a history of which rules blocked jobs.
Review the evidence and the proposed edit before you select **Approve
suggestion**. **Reject suggestion** discards the proposal without saving.
See the [suggestions contract](../../contracts/settings-suggestions-api.md).

## Local refresh server

In the selected, writable local dashboard, select **Run**. In the confirmation
dialog, select **Start refresh** or select **Cancel** to close the dialog without
starting a refresh. A refresh reads live NAV data and can call the configured
model. It uses the same workflow and installation lock as `pulse refresh --no-publish`. It does
not upload to Railway. If another refresh holds the lock, the dashboard reports
that a run is already in progress.

The dashboard checks progress about every two seconds. It shows the stage
status, retry wait and final result. After success, it loads the new saved
snapshot. Closing the tab does not stop the refresh. Stopping the dashboard
server interrupts its refresh and releases the lock. On reopen, the dashboard
shows the last run result if one is available. It shows the end time in Oslo
time when known. Failure messages do not include raw logs. After a readiness
refusal before the first stage, fix the cause and select **Run** again. If a run failed
after it entered a stage, select **Reset and run** and confirm to start a new
run. See the [retry and reset rules](../operations/local-pipeline.md).

Select **Show details** on Home or open the **Run** tab to follow the refresh log.
The log shows stage results, counts and review batches. It follows new entries
while you are at the bottom. It keeps the latest 2,000 entries in memory for
one dashboard-started run. A new run or server restart clears the log. If an
external refresh replaces the result shown here, its saved result has no log.

The read-only dashboard, demo and hosted dashboard have no Run tab, button or
[run endpoints](../../contracts/local-run-api.md). Offline tests use a fake
refresh. They do not verify a live run from the dashboard.

## Local server boundary

- The local command binds only to `127.0.0.1`. Local adapter startup rejects a
  non-loopback `HOST` or Unix socket selection.
- Only direct loopback or the opt-in [Tailscale Serve route](phone-view.md#open-the-local-dashboard-through-tailscale-serve)
  can bypass the local login gate. Both require a native loopback socket.
  Forwarded headers cannot select the local client address. Startup rejects every nonempty `ADDRESS_HEADER`.
  With the pinned empty adapter envPrefix, its original-Request socket closure
  is the fallback when origin normalization replaces the Request.
  An unknown or non-loopback client needs login.
- Hosted mode always needs login, including for a loopback request inside a
  container. Railway markers cannot downgrade that requirement to local mode.
- Host checks run before pages, snapshot reads and other private routes.
  The local default allows only `127.0.0.1:<port>` and `localhost:<port>`.
  `DIGEST_VIEW_ALLOWED_HOSTS` can select exact entries. A bad Host returns 403.
- `/healthz` is public and carries no private configuration. The Bun adapter
  also serves only generated app-code assets publicly. This includes JS, CSS,
  fonts and icons, not HTML, snapshots, databases or arbitrary static files.
- Page and data responses are no-store, no-referrer and no-sniff. SvelteKit adds
  hashes for its own bootstrap to the same-origin CSP. Login has a separate
  form policy. No external fonts, scripts, analytics or model requests run.

Do not expose local mode through a proxy or tunnel other than the explicit
private Serve route. Never use Funnel. This guide does not grant network or
hosting permission.

## Local feedback

Feedback is local only, including access to the local dashboard over Tailscale.
Set `DIGEST_VIEW_FEEDBACK_PROFILE` to one profile slug to enable stars and
thumbs. It must match the profile in the selected saved snapshot. Without a
match, the controls are unavailable. They do not fall back to browser storage.

The app uses `/app/shortlist-feedback`. The server also accepts the existing
`/shortlist-feedback` path. Both use the same Host check and authorize a real
direct loopback socket, approved Serve owner or a signed local viewer session.
A write also requires the exact Origin and the CSRF token from GET. Direct
loopback uses an HTTP Origin. Serve uses the configured HTTPS origin. Both
use a process token. The signed-session path uses HTTPS and a token bound
to the session. Only listing IDs in the saved capture are eligible.

The data directory must already exist and be managed by the server owner.
Feedback uses its own private `PULSE_DATA_DIR/shortlist-feedback.sqlite3` file.
Snapshot uploads must not replace it. These controls do not start pipeline
work or change profile ratings. See the [feedback API contract](../architecture/contracts.md#shortlist-feedback-api).

The [starred-jobs API](../architecture/contracts.md#starred-jobs-api-v1)
has its own optional server settings and bearer gate. The bearer does not
permit browser feedback writes.

## Verification limits

Offline checks do
not establish deployment, live credentials, owner acceptance on a phone,
restart retention, or fresh source data. The [local feedback events API](../../contracts/feedback-events-api.md)
has offline coverage.
