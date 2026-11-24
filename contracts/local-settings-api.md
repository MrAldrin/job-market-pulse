# Local settings API

The dashboard editor reads and writes current settings through Profile. This
internal HTTP contract is separate from the saved snapshot and feedback. The
[Effect Schema](../src/lib/contracts/local-settings.ts) owns the wire shapes
and shares value validators with the TOML readers. There is no version header
or registry entry.

## Access

`/app/local-settings` exists only for a local launch with an explicit settings
target, on a real loopback socket and an allowed Host. The same access checks
apply to all settings actions, including model and notification tests. The
[private Serve route](../docs/dashboard/phone-view.md#open-the-local-dashboard-through-tailscale-serve)
also checks the configured owner. A hosted session does not
grant access. The route accepts no query parameters, file paths or profile
selectors. All responses use `Cache-Control: no-store`.

## Read

`GET` returns `profile_id`, `csrf_token`, `models`, `filters`, `judge`,
`screen`, `search_mode`, `schedule` and `narrative`. Each settings object has its file's
`revision`. `models.steps` has `screen`, `judge`, `rejudge` and `calibrate`.
Each step has `harness`, `provider`, `model` and `effort`. The `models.pi_catalog`
field contains the cached Pi list, or `null` if no usable list is saved. Each list
entry has `provider`, `model` and `efforts`. An empty `efforts` array means that
the picker cannot save a new choice for that model. `HEAD` omits the body.
The optional `rejudge` object contains `levels` and `same_as_judge`.
If absent, re-judge is off and follows the Judge model.

| Object | Other fields | File |
| --- | --- | --- |
| `filters` | `location` (`home_postcode`, `radius_km`, `place`), `excluded_title_terms`, `excluded_employers`, `excluded_municipalities`, `allowed_occupation_categories` | `filters.toml` |
| `judge` | `preferred_terms` | `judge.toml` |
| `screen` | `values` with editable title terms and `advanced` with read-only patterns | `screen.toml` |
| `search_mode` | `mode` (`passive` or `active`) | `profile.toml` |
| `schedule` | `expression` and `anchor` (date or `null`) | `profile.toml` |
| `narrative` | `text` | Configured private comparison profile |
| `notifications` | `enabled`, `topic_configured`, `dashboard_url` (HTTPS or `null`). Never returns the topic. | Installation `local_only/ntfy.toml` |

An unavailable `judge`, `screen`, `schedule`, `narrative` or `notifications` section is `null`.
Other available sections can still be edited. Revisions and the token are
opaque lowercase hex strings of 64 characters.

## Actions

Send `POST` with the exact HTTP `Origin`, `X-CSRF-Token` from GET, and bounded
`application/json` with a `Content-Length` of at most 256 KiB. The body must
have exactly the fields for one action.

### Save

```json
{"kind":"model","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","step":"judge","harness":"pi","provider":"invented-provider","model":"invented-model","effort":"high"}
```

```json
{"kind":"excluded_title_terms","revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","values":["invented title"]}
```

The first update changes the harness, model and effort for one step. The batch
size and other steps stay the same. A new Pi selection needs a model and effort
in the cached list. A new Claude Code selection needs the `anthropic` provider
and one of the supported aliases. The second update replaces only the selected
profile's excluded title terms. Send the revision of the file to change. A
successful save returns `200` with `{ "revision": "..." }` for that file. No save
starts a run or modifies the snapshot.

The `screen` action accepts only editable `values`, grouped by list. Use
words or phrases with an optional final `*`. An omitted list is unchanged.
An empty list removes only editable terms. Profile preserves advanced patterns
and the original pattern spelling for terms that remain in the list.

The `rejudge` action takes the model file revision, `values` with those two
fields, and `model`. Use distinct first-score levels from `exceptional`,
`strong`, `possible`, `poor` and `unknown`. An empty list turns the pass off.
Use `null` for `model` when following Judge. Otherwise send `harness`,
`provider`, `model` and `effort`. A Pi model not in the list can be entered
manually. A save changes only the re-judge entry in `models.toml`.

The remaining actions also take `kind`, `revision` and `values`:

| `kind` | `values` |
| --- | --- |
| `location` | Object with four-digit `home_postcode` and `radius_km` (greater than 0 and at most 1000). |
| `filters` | Object with `excluded_municipalities`, `excluded_employers` and `allowed_occupation_categories`. Location and title exclusions stay the same. |
| `judge` | Preferred terms as a string array. |
| `screen` | Object with any of `academic`, `business_development`, `sales`, `tech_words`. Omitted lists stay the same. Use an empty array to clear a list. |
| `search_mode` | `passive` or `active`. Changes only `[policy].mode` and shares the `profile.toml` revision with `schedule`. |
| `schedule` | Object with `expression` and `anchor`. Interval schedules need a valid start date. Other schedules use `null`. Saves configuration only, not timer state. |
| `narrative` | Comparison profile text, at most 100,000 UTF-8 bytes. |
| `notifications` | Object with `enabled`, `dashboard_url` and `topic`. A `null` topic keeps the saved topic. Enabling needs both a topic and an HTTPS dashboard URL. |

A location save returns the new `revision` and the read-only `location` object.
`place` is `null` until the origin and place are known. Profile uses the bounded
[postcode-area lookup](../docs/pipeline/geography.md#profile-origin-lookup) when
the postcode changes or has no usable saved origin and place. The request
sends only the postcode as input to that lookup. On failure the file stays
unchanged. The editor never sends or receives origin coordinates.

### Refresh the Pi list

Send `{"kind":"refresh_models"}`. The server sends `get_available_models` to
local Pi RPC without a prompt. On success it replaces
`local_only/pi-model-catalog.json` in the selected installation and returns the
list. On failure it leaves the previous list unchanged.

### Test a model

Send the same fields as the model save, with `"kind":"test_model"`. The server
checks the current model file revision and the selected values. The exact
current saved setting can also be tested if it is no longer listed. The server
makes one harness invocation with a fixed prompt. It does not send settings,
profile, or job text as prompt input. Success returns `200` with
`{ "ok": true }`. This action does not save settings.

The [suggestions API](settings-suggestions-api.md) uses this editor's save
protocol for explicitly approved changes.

### Test a notification

Send `{"kind":"test_notification","revision":"..."}` with the notification
settings revision. The server uses the saved topic and makes one
[fixed test request](ntfy-notifications.md). The action does not save settings.
Success returns `200` with `{ "ok": true }`. A send failure returns `502`
without provider details.

### Errors

| Status | Meaning |
| --- | --- |
| `400` | Malformed request or invalid update |
| `403` | Host, Origin or token check failed |
| `404` | The route is unavailable or the request includes a query |
| `405` | Unsupported method |
| `409` | The file changed since the read or the installation lock is busy |
| `413` | The request exceeds the body limit |
| `502` | The model list, model test or notification test failed |
| `503` | Settings are unavailable or cannot be saved, or the harness is missing |
| `504` | The model test timed out |
