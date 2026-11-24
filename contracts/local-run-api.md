# Local run API

This unversioned API is available only on the selected, writable local dashboard
over its native loopback socket. This includes explicitly configured
[private Tailscale Serve access](../docs/dashboard/phone-view.md#open-the-local-dashboard-through-tailscale-serve).
It has no hosted, read-only or demo route.
The server selects the installation root and profile. Requests cannot change
either.

| Request | Result |
| --- | --- |
| `GET /app/run/status` | `200` with the current state and a CSRF token. `HEAD` omits the body. |
| `POST /app/run/start` | `202` with no body after the server acquires the installation lock. |
| Start while the desktop close guard is set | `409`: `The app is closing`. |
| Start while the installation lock is held | `409`: `A run is already in progress`. |
| Start with a missing or stale reset ID, or reset when none is required | `409`: Check the run status and confirm again. |
| Start or status unavailable | `503` with a short error. |

The Host gate applies to both paths. Start requires the same Origin (HTTP
for direct loopback, configured HTTPS for Serve),
the status response token in `X-CSRF-Token`, and an `application/json` body
with exactly `{"confirm":true}` for a normal run, or
`{"confirm":true,"reset_run_id":"<ID>"}` to reset the stopped run identified
by status. The client must ask for confirmation first. The server checks the
reset ID against the saved record while it holds the installation lock.
For browser POST use `referrerPolicy: "same-origin"` so Chromium sends the
Origin under the dashboard's no-referrer response policy. Other methods return
`405`. Query strings are not supported. Responses use `Cache-Control: no-store`.

## Status

The [Effect Schema](../src/lib/contracts/local-run.ts) defines the wire fields.

- `status`: `idle`, `running`, `succeeded` or `failed`.
- `current_stage`: the active stage or the stage waiting for retry. It is
  `null` during preflight, between stages and after the run ends.
- `stages`: the stage name and its status, in pipeline order. Market can be
  `recorded`, `skipped` (recording disabled) or `failed`. A Market failure does not
  stop the pipeline. A retry wait has status `waiting`. When that wait ends,
  live stage statuses reset for the new preflight.
- `last_market_recording`: the saved capture time and pipeline run ID of the
  latest known successful Market recording. Later skipped or failed stages
  do not replace it. The field is omitted when no evidence is saved.
- `started_at`, `ended_at` and `retry_at`: UTC times, or `null` if unknown or
  not applicable. After a server restart, the run record can supply `ended_at`
  but not `started_at`. Older run records may have neither.
- `reset_run_id`: the saved run ID if a reset is required, or `null`.
- `error`: a fixed message or `null`. The API translates recognized saved
  failure details and does not return
  raw logs, model output, credentials or private paths.
- `log`: up to 2,000 entries for the latest dashboard-started run in this
  server session. Each entry has `sequence`, `time` (UTC), `stage` (`null` for
  the run as a whole), `level` and `message`. Sequence starts at 1 on each run.
  When the limit is reached, the oldest entries drop out. Saved records do not
  reconstruct the log after restart.
- `csrf_token`: a server-scoped value for start only. Read a fresh token after
  server restart.

The client can poll status about every two seconds. Closing a tab does not
stop a run. Stopping the server interrupts its run and releases the lock.
After restart the server reads the selected profile's existing pipeline
record. Older run records without stage results show “Status not saved”. The
dashboard does not infer missing times or a Market result. A saved unfinished
run has no confirmed result and might be running outside the dashboard; it is
not reported as an active dashboard run. A refusal before the first stage
allows a fresh Run. If a run failed after it entered a stage, only
**Reset and run** can start a new run from the dashboard. See the
[retry and reset rules](../docs/operations/local-pipeline.md) for recovery.

## Desktop close control

The desktop main process sends `POST /app/run/desktop-close` to block new
starts and check whether the dashboard owns a run. This is one server action.
The reply is `200` when a run is active (including admission or retry wait), or
`204` otherwise. If the user keeps the app open, `DELETE` clears the guard and
returns `204`. The guard does not control runs started outside this server.

This control requires direct loopback and a separate per-launch token in
`X-Pulse-Desktop-Token`. The shell passes the token through the child process
environment, not page data. The shell sends a strictly increasing positive
integer in `X-Pulse-Close-Sequence`. The server rejects stale requests with
`409` so a delayed prepare cannot override a newer cancel. These methods are
not available to Tailscale Serve, hosted, read-only or demo dashboards.

## Progress boundary

The [pipeline progress contract](../src/lib/contracts/pipeline-progress.ts)
carries attempt, stage start, stage finish, retry wait and typed progress counts
from the locked pipeline. Review batch numbers count calls as they start;
there is no fixed total because screening and source text checks affect the
remaining batches. Log messages use fixed text and validated counts only. The
API does not return ad text, titles, prompts, profile text or process output.
The runner saves each finished
stage result before reporting it. A recorded Market result also carries the
capture time and pipeline run ID. Snapshot data continues to supply the result
views.
