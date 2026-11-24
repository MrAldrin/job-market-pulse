# Dashboard snapshot v3

The runtime [Effect Schema](../src/lib/contracts/snapshot.ts) is the validator.
Version 3 keeps the [v1 result fields](snapshot.schema.json) and adds a required
`settings` object. It does not include v2 `market_history`. The JSON and SQLite
upload container keep their existing locations and physical format. The strict
v1 and v2 readers remain available; they do not synthesize settings. New
refreshes save [v5](snapshot-v5.md).

## Settings fields

| Section | Captured values |
| --- | --- |
| `policy` | `market_only` and `freshness_max_age_hours`. Search mode stays in `profile.mode`. |
| `filters` | `radius_km`; preferred, nearby and excluded municipalities; allowed occupation categories; title and employer exclusions; preferred terms. Lists can be empty. |
| `title_screen` | Configured `academic`, `business_development`, `sales` and `tech_words` lists. No raw config or opaque version field. |
| `sources` | `name: "nav"`, `excludes_finn: true`. This is the retained source policy, not a coverage check. |
| `review` | Configured `screen`, `judge`, `rejudge` and `calibrate` steps. Each has `harness`, `provider`, `model`, `effort` and `batch_size`. These values do not establish provider access or that all steps ran. |
| `schedule` | `kind: "never"` or a normalized recurrence, and `timezone: "Europe/Oslo"`. A recurrence has `interval`, `weekday` (Monday is 0), `day_of_month`, `time` (`HH:MM`) and `anchor`. Inapplicable fields and an interval without a valid saved anchor are null. |
| `notifications_enabled` | Optional boolean. No topic or dashboard URL. This value does not prove delivery. |

The producer maps named fields from the selected profile and the model settings
admitted by review preflight. It does not include credentials, private narrative,
exact home location or postcode, runner commands, paths, raw files, fingerprints
or timer state. Search terms and model labels are displayed as text. Do not put
secrets or other private details in those settings. Keep the payload private.

A list that exceeds the display limits is null, not shortened or shown as
empty. Each list is limited to 2,000 items, 2,000 characters per item, and
32 KiB as encoded JSON. A label that does not fit the display-safe model label
format is also null. These limits do not change the local settings.

`generated_at` is the snapshot capture time. A schedule is a saved choice,
not proof that a timer is enabled or that a run will occur. Viewing settings
cannot start the pipeline or edit settings. Existing feedback is separate.
