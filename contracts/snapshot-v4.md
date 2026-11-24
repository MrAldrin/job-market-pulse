# Dashboard snapshot v4

V4 keeps the [v3 fields and limits](snapshot-v3.md) and adds a required
`personal_inputs` object. The [runtime Schema](../src/lib/contracts/snapshot.ts)
validates v1 through v6. Versions before v4 do not contain these private inputs.
The JSON path and SQLite upload container format do not change.

| Field | Captured value |
| --- | --- |
| `home_location.label` | Saved place label, or null if absent or over the display limit. |
| `home_location.home_postcode` | Legacy home postcode used by the geography rule, or null. |
| `home_location.area_postcode` | Legacy postcode for the setup area. New captures write null. |
| `home_location.origin` | Saved latitude and longitude for radius checks with the origin source label. If the label exceeds the display limit, it is null and the coordinates remain. If no origin is set, the whole field is null. |
| `narrative` | Comparison profile text from the selected profile. The text is unchanged, with the same 100,000 UTF-8 byte limit as review. |

The place and source labels have a 2,000-character display limit.

When re-judge is configured, `settings.rejudge` records the selected first
score levels and whether the pass follows Judge. `settings.review.rejudge`
then describes the effective second model. If a job has an accepted second
score, `jobs[].assessment` and `result_id` refer to that result and
`reviewed_at` is its saved time. `jobs[].rejudge` records the first fit and
both model labels. An unknown label is null. `first_found_at` does not change.
V4 and later capture `settings.rejudge`, `jobs[].rejudge` and the second review's
time. Older exports keep their existing fields. Snapshots without these
optional fields still load in the updated viewer.

The personal review also uses the search and review preferences shown in
`settings`. The new location fields show the saved origin, not a live lookup
or an address for a job. The snapshot does not prove that each saved review
used these inputs. Do not put credentials or tokens in the narrative or
settings. The producer does not read credentials or copy profile paths,
runner commands or raw configuration into these fields.

Keep the JSON and its upload container private. The local dashboard uses its
loopback boundary; the hosted dashboard requires login. Public routes and the
bearer jobs and feedback exports do not return these fields. Follow the
[viewer-first release order and upload gate](../docs/operations/phone-snapshots.md#settings-snapshot-compatibility)
before publishing a snapshot with real private inputs.
