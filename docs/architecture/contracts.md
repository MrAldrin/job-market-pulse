# Architecture contracts and boundaries

This page describes current data boundaries. Brick contracts (`contracts/README.md`) own versioning and
validation rules. Schemas and synthetic fixtures own exact versioned shapes; they are not evidence of live
integration. The [brick map](bricks.md) shows current and intended consumers.

## Snapshot v1 contract

Snapshot v1 is saved display data for Dashboard and the intended Alert reader, not private profile files or
pipeline tables. SQLite remains the working store; JSON is the current export format. The contract is its types,
`schema` and `schema_version`. The retained compatibility [schema](../../contracts/snapshot.schema.json),
[example](../../contracts/fixtures/snapshot.example.json) and `src/lib/contracts/snapshot.ts` own exact
fields and validation.

Snapshot builds and reads saved display data. It does not refresh NAV, start review or change input databases. Saved reads use `SnapshotStore` or `SnapshotJsonFile` with the canonical validator. Dashboard route composition must pass validated data through typed
Kit `PageData`; components must not read stores. Alert has not fully migrated
to this boundary.

| Writer | Output and limits |
| --- | --- |
| Pipeline snapshot stage | `SnapshotCapture` captures the profile-local `dashboard-snapshot.sqlite3` and writes companion JSON beside it. |

The writer validates before atomic UTF-8 replacement with mode `0600`. It refuses symlinks, unrelated existing
files and invalid existing snapshots. JSON failure is a warning: capture may succeed and an old companion JSON
may remain. Upload uses the profile-local SQLite container. Local output does not prove freshness or a hosted
release.

The capture API is in `src/lib/server/snapshot/capture.ts`. The existing SQLite path
and schema remain active for refresh, publish and status. Each capture retains
the same validated JSON, shortlist/starred metadata and digest/shortlist HTML for
legacy transport, with `dashboard_views=None`. It does not render the retired dashboard pages or write `source-report.html`. Path, read-only input and
feedback-store guards remain. See [capture commands](../operations/phone-snapshots.md).

All documented keys are required, including nullable keys; unknown keys are rejected. Null means unknown or
unavailable, not zero. Timestamps have time zones; producers should use UTC. Dates use `YYYY-MM-DD`. See the schema
for field types, nullability and exact bounds.

| Section | Meaning and limits |
| --- | --- |
| `generated_at`, `profile`, `source`, `counts` | Export time, profile ID/mode, saved source check and coverage, and saved funnel counts. `source.name` is currently `nav`. Counts are not whole-market totals, guaranteed partitions or validated arithmetic. |
| `jobs` | Unique saved reviewed-funnel jobs, open before closed. Status is saved evidence, not a live check. Locations are workplace labels; URL is HTTPS. `first_found_at` and `reviewed_at` are the earliest full-review time in v1. `result_id` may be null. Missing full review gets unknown assessment, no evidence and `ad_text_reviewed: false`. |
| `expires_at` | Listing expiry, **not an application deadline**. Display as “Listing expires”, not “Apply by”; v1 has no application-deadline field. |
| `assessment` | Fit is exceptional, strong, possible, poor or unknown. Strong and exceptional need reviewed ad text and evidence; exceptional also needs passed hard constraints and no uncertainties. Validation checks claims, not their truth. |
| `shortlist` | Ordered references to open jobs and a human-readable rule. Passive keeps exceptional; active keeps exceptional then strong, newest first-found within fit, without a quota. Saved-history lifecycle checks differ from strict digest freshness checks. Dashboard preserves that order. |
| `market` | Nullable retained titles-only monitored NAV sample, with taxonomy, capture time, monthly and optional weekly series. Periods, families and terms have aligned counts; missing values stay null, not zero. Compare only identical taxonomy versions; closed periods do not prove complete coverage. See [market counts](../pipeline/market.md). |
| `reviewed_trend` | Nullable weekly/monthly retained funnel counts by first-seen date, not first-review date. Unique labels and increasing dates; closed ads removed from source are excluded. This is not the market sample. |
| `salary` | Nullable facts for exported jobs, not the market; no raw ad text. `undated` counts facts excluded for unusable source-version time. Ad rows retain nullable salary amounts, period, SKO and grade information, inference, midpoint and closure flags. Monthly medians use plausible yearly midpoints only and are null below five numeric brackets. See [salary retention](../pipeline/nav-reader.md#what-is-retained-and-what-the-summary-means). |

Market period coverage is `partial`, `unverified`, `closed`
or `missing`; `partial` is true unless coverage is closed. Salary months and trend periods are unique and
increasing; implausible salary values remain in ad rows but not medians.

Keep exports ignored. Do not export profile narrative, preferences, home coordinates, postcode, `home_label`,
radius or raw ad text. Assessment evidence is bounded review text. Free text is untrusted and may quote private
values; validation cannot detect that. Inspect a real export before separately approved publication. Feedback
stores remain separate; see [feedback events](#feedback-events). A valid snapshot does not prove a fresh source,
successful run, alert delivery, hosted integration or owner acceptance.

The validator checks timestamps, unique job IDs, open shortlist and salary references, aligned market counts and
ordered periods. Integer fields reject booleans and floating-point forms for integers. Text is bounded to 2,000
characters; trimmed review text is 1–1,000. Evidence and uncertainty arrays have at most 20 items; jobs, shortlist
IDs, locations, market rows and salary ad rows at most 2,000; periods and monthly arrays at most 1,200. Counts are
0–10,000,000. Schema and validator own exact constraints. For growth, split JSON by page or period first;
SQLite-in-browser and Parquet are not implemented.

Validate saved data with the owner Schema. The retained CLI has no standalone contract check.

## Snapshot v2 Market history

The TypeScript runtime contract is `src/lib/contracts/snapshot.ts`. Its strict
v1 variant keeps the existing fields. The explicit v2 variant adds required
nullable `market_history`. Readers do not upgrade v1 or invent missing detail. The retained JSON Schema remains
a v1 compatibility reference, not a generated TypeScript export.

V2 history exposes only aggregate points and the fixed Market capture metadata.
It preserves frozen versus recorded origin and separate population, text and
occupation coverage. Current-stock points are not labelled as complete historic
periods. It excludes database IDs, host paths and raw ad data. See the
[dashboard snapshot boundary](../dashboard/new-dashboard.md#snapshot-boundary)
for the field list, reader/writer APIs and offline limits. The physical upload
container schema stays unchanged.

## Snapshot v3 settings

V3 adds a required [settings projection](../../contracts/snapshot-v3.md). V4
keeps those fields and adds [private review inputs](../../contracts/snapshot-v4.md).
[V5](../../contracts/snapshot-v5.md) adds the counts for the About page. Full
captures now write [v6](../../contracts/snapshot-v6.md), which adds job distance.
The reader accepts v1 through v6 without inferring absent fields. The upload
container schema stays unchanged.

## Candidate manifest contract

Filter supplies Judge a source-bound manifest through the replaceable local, read-only `CandidateSelector.manifest`
interface. The builder in `src/lib/server/filter/manifest.ts` does not call a model. This older boundary has no separate
schema or validator; its [fixture](../../contracts/fixtures/manifest.example.json) and existing review checks
define behavior. All keys below are present unless marked optional.

## Manifest keys
| Key | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | Existing manifest version, currently 1. There is no `schema` key. |
| `profile_id` | string | Explicit lowercase profile slug, at most 64 characters. |
| `profile_fingerprint` | string | SHA-256 of the exact private profile bytes; not the profile text. |
| `preferences_fingerprint` | string | Preference-version digest of the loaded preferences. |
| `rules_fingerprint` | string | SHA-256 of the selected parsed title rules. The personal path defaults to a fixed neutral rule identity. |
| `scoring_version` | string | Version of the deterministic scoring rules, including the effective [title evidence pack](../pipeline/relevance.md). |
| `fit_preferences` | object | Minimized preference context, described below. No exact origin or profile text. |
| `coverage_id` | string | SHA-256 binding of common inputs and all eligible candidates, sorted by ID. |
| `candidates` | array of objects | Selected batch. Order is source version descending, then ID ascending for ties. |
| `manifest_id` | string | SHA-256 binding of common inputs, coverage ID and selected candidate records in their order. |
| `checked_at` | timestamp string | Source check time with timezone; not the manifest construction time. |
| `caught_up` | boolean | Always true in a successful manifest. |
| `coverage` | string | Bounded NAV change-feed coverage statement; excludes FINN-sourced ads. Not whole-market coverage. |
| `eligible_count` | integer | All candidates admitted by the current filters. |
| `reviewed_count` | integer | Eligible candidates present in the supplied exclusion/reviewed-ID set. |
| `candidate_count` | integer | Number of candidates in this batch. |
| `remaining_count` | integer | Pending candidates before this batch is selected; includes this batch. |
| `candidate_offset` | integer or null | Offset into pending candidates; null for an explicit candidate-ID batch. |
| `batch_index` | integer | One-based offset batch index when pending candidates exist; otherwise 0. Explicit-ID batches use 0. |
| `batch_count` | integer | Ceiling of pending count divided by limit. |
| `batch_ids_fingerprint` | string | SHA-256 of the selected candidate IDs in batch order. |
| `limit` | integer | Requested batch size, from 1 through 120. |
| `truncated` | boolean | Pending count exceeds selected count plus offset. |

## Candidate keys
| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | Source listing UUID. |
| `version` | timestamp string | Source change version. |
| `title` | string | Source title. |
| `employer` | string | Source employer label. |
| `locations` | array of strings | Source location labels. |
| `url` | string | NAV listing URL. |
| `expires_at` | timestamp string or null | Parsed source expiry, or null if missing. |
| `detail_missing` | boolean | Source details were not available. |
| `geography` | string | Always `inside`; outside and unknown jobs are not candidates. |
| `geography_reason` | string | Explanation of the geography result. |
| `occupation_categories` | array of strings | Source occupation labels used by admission. |
| `geography_evidence_digest` | string, optional | Digest of verified, source-bound workplace evidence, when available. |

## Fit preference keys

| Key | Type | Meaning |
| --- | --- | --- |
| `preferred_terms` | array of strings | Explicit scoring terms. An empty list is neutral and does not admit a job. |
| `allowed_occupation_categories` | array of strings | Explicit allowed NAV occupation categories. |
| `preferred_municipalities` | array of strings | Legacy field; new manifests write an empty array. |
| `nearby_municipalities` | array of strings | Legacy field; new manifests write an empty array. |
| `excluded_title_terms` | array of strings | Explicit title exclusions. |
| `excluded_employers` | array of strings | Employer exclusions. |
| `excluded_municipalities` | array of strings | Place exclusions, or an empty array when not explicitly configured. |
| `hard_limits` | object | Geography and profile constraint context, described below. |

## Hard limit keys

| Key | Type | Meaning |
| --- | --- | --- |
| `geography_radius_km` | number | Configured straight-line radius. |
| `geography_radius_is_explicit` | boolean | True for an accepted personal manifest. |
| `geography_already_applied` | boolean | True; candidates have passed the geography filter. |
| `exact_origin_included` | boolean | False; the exact origin is not copied. |
| `other_constraints` | string | Instruction to use only constraints in the supplied profile; otherwise keep them unknown. |

Common binding inputs are schema version, profile ID and fingerprint, preferences and rules fingerprints, scoring
version and fit preferences. Fingerprints use compact sorted JSON and SHA-256.
The profile digest uses the exact narrative bytes. Metadata counts and check
time are not part of `manifest_id`. The temporary `_eligible_candidates` key
is removed before output. Candidate records, not IDs alone, bind a submission.
The writer rebuilds the manifest before it accepts a response.
[Saved review reuse](../review/hand-run-review.md#saved-state-and-reuse) uses
a narrower binding. Admission changes do not invalidate accepted results.

| Bound or requirement | Value |
| --- | --- |
| JSON input and each public manifest | 2,000,000 bytes; nesting at most 64 levels |
| Source / eligible pool / coverage binding | 100,000 ads / 10,000 candidates / 32,000,000 bytes |
| Batch size / batches | 1–120 candidates / at most 100 batches |
| Profile | Existing non-whitespace file, at most 100,000 bytes |
| Source freshness | Default 24 hours; positive max age, aware current time, caught-up source, no future or stale check |

Personal manifests require explicit preferred terms, nonempty occupation categories, radius and locality origin. Admission applies
expiry, exclusions and geography, then occupation-category matching. A title term does not admit a job. Missing inputs or exceeded bounds raise
`FitContractError`, never a partial result. Batch construction binds the full coverage and checks that each pending
ID appears once.

## Profile bundle: current keys

See [Private profiles](../pipeline/profiles.md) for file ownership and compatibility paths. Radius, occupation and explicit exclusions affect admission and review context. Preferred terms do not admit jobs outside those limits. Exact origin coordinates are not model input.

## Local feedback events API

The [local read contract](../../contracts/feedback-events-api.md) uses
feedback-events v1 for current stars and reactions. It shares the
server-bound starred-jobs bearer gate, not browser write authentication.

## Shortlist feedback API

The local dashboard's authenticated `/shortlist-feedback` viewer API has no versioned schema header. A proxy removes its
`base_path`; query strings are not accepted. The server selects the profile and allowed listing IDs from validated
snapshot JSON when present, otherwise from trusted legacy shortlist capture metadata.
JSON authority includes all exported jobs, in snapshot order, not only the Home
shortlist. Invalid JSON does not fall back to legacy metadata. Clients cannot
select profile, database or arbitrary jobs. Stars and reactions use a separate
SQLite store and do not change snapshots, selection, five-level ratings or the profile. The [wire
fixture](../../contracts/fixtures/feedback_api.example.json) provides synthetic examples.

| Request | Contract |
| --- | --- |
| GET / HEAD | A viewer session cookie is required. GET returns `csrf_token` (64 lowercase hex, bound to the signed session), `listing_ids` in capture order and `states` keyed by ID with boolean `starred` and `reaction` (`up`, `down`, null). Missing rows are false/null; an empty capture gives empty array/object. Profile and `updated_at` are omitted. HEAD has the same checks and headers without a body. Reload the token when the session changes. Browser requests use same-origin credentials and no-store. |
| POST | Send one `application/json` content-type, exact same-origin `Origin`, session cookie and one `X-CSRF-Token` from GET. Body requires exactly `listing_id`, `field`, `value`, no duplicates or extras. ID matches `[a-z0-9_-]{1,128}` and must be in the capture. `field` is `starred` with JSON boolean, or `reaction` with `up`, `down` or null. The operation sets, not toggles; retry is safe and preserves the other field. Response contains only `state`. Do not show an unconfirmed value as saved. |

Successful responses use JSON UTF-8 and `Cache-Control: no-store`. Login uses the viewer's `/login`, not separate
API credentials. Exactly one allowed Host is required. POST requires exactly one Origin with matching authority,
ignoring case, without user info, path, query or fragment. HTTPS is required unless Host is explicitly in
`http_origin_hosts`. Body limit is 1024 bytes; one non-negative 1–10 digit ASCII decimal Content-Length is
required. Content type is exactly `application/json` after trim/lowercase, with no charset. Transfer-Encoding,
Content-Encoding, Expect and Trailer are rejected. The complete body must be UTF-8 JSON. The socket timeout is
bounded; protocol failures may close without a response, and POST closes after reply.

| Status | Application handler result |
| --- | --- |
| 200 | Successful GET, HEAD or POST. |
| 303 | Configured login with absent, invalid or ambiguous session; redirect to mounted login. |
| 400 | Invalid POST route, headers, length, body, JSON, shape, ID, field or value. |
| 403 | Missing, duplicate or disallowed Host; invalid, missing or duplicate POST Origin or CSRF token. |
| 404 | GET/HEAD with no login, non-exact route, missing snapshot or invalid capture; POST ID outside capture. |
| 405 | POST without configured login, or denied write method; Host/login gate may run first. |
| 413 | Body exceeds 1024 bytes. |
| 503 | Snapshot, feedback module/store, unsafe path or saved-state failure; no private details. |

Parser errors are not JSON API documents; error shapes are not stable. The login form's 401 is not a feedback-route
result. The [local dashboard guide](../dashboard/new-dashboard.md#local-feedback) owns local adapter differences.
The app applies the
[local dashboard rules](../dashboard/new-dashboard.md#local-feedback) and requires an explicit selected profile.
Offline fixture and handler tests do not establish live or owner phone acceptance.

## Starred-jobs API v1

`GET <base-path>/api/v1/starred-jobs` is a separate, server-bound bearer capability on the local viewer only.
It returns the complete retained star set for one profile, not just the newest
shortlist. The frozen v1 authority is the sibling repository
`job-applications/docs/integrations/pulse-stars-contract.md`.
The [synthetic wire fixture](../../contracts/fixtures/starred_jobs_api.example.json)
matches its accepted example. It is an external API, not a `pulse.*` brick
document; do not add a schema header or change the v1 response.

`pulse.feedback.starred_jobs` owns the producer and bounded source reads.
`pulse.feedback.starred_job_metadata` validates the additive `starred_metadata`
BLOB in the HTML snapshot store. Shortlist capture supplies typed summaries;
snapshot publish/export preserves the metadata with the selected row.
The local pipeline already captures with `--shortlist`, so it uses this path too.

The response has `schema_version: 1`, server-bound instance/profile IDs, UTC
`exported_at`, nullable `snapshot_at`, `complete: true` and sorted `jobs`.
Each job contains its NAV ID/link, star, nullable reaction, whole-row feedback
update time, details state and nullable summary. A summary contains only title,
employer, application deadline, source expiry/status/version and source-check
time. Unknown facts stay null or unknown. No ad body, profile text or owner notes
cross this interface.

Only matching structured metadata from the newest row can enrich an ID.
Missing or legacy captures allow ID-only results; corrupt metadata is a failure.
Closed, expired or 24-hour-old summaries are withheld. Capture also omits
summaries when saved expiry is unconfirmed. A star does not prove an open job
or extend text retention.

Host validation precedes bearer authentication. Browser cookies do not authorize
this route, and its token grants no browser or feedback-write access.
Responses use no-store and generic errors: disabled `404`, bad credential
`401`, bad query/body `400`, disallowed Host `403`, other methods `405`,
and unavailable/unsafe/invalid/over-limit stores `503`. A success is `200`
with at most 1,000 jobs and 2 MiB of JSON, never a truncated complete set.
Set `DIGEST_VIEW_STARRED_INSTANCE` to a stable source slug,
`DIGEST_VIEW_STARRED_PROFILE` to one profile slug and `DIGEST_VIEW_STARRED_TOKEN`
to a separate 43–256 character base64url secret. Set all three or leave all
unset. Partial or invalid settings block local startup. Keep the token out of
URLs, command arguments, logs and tracked files.

SQLite reads are read-only, with a 32 MiB limit per database and a 100 ms busy
timeout. An absent or invalid feedback database is not an empty feed.
See [Railway consumer impact](../operations/railway.md#read-only-starred-job-export).

## Feedback events

The local export service reads saved local feedback for one profile; it does not fetch phone data, change stores,
call a model or apply profile changes. The [version-1 schema](../../contracts/feedback_events.schema.json),
[example](../../contracts/fixtures/feedback_events.example.json) and validator own exact keys. `schema` is
`pulse.feedback_events`; `events` has at most 50,000 entries ordered by UTC creation time then stable unique event
ID. Each event contains listing identity/source, optional source version and result ID, kind, value, reason,
creation time and origin. Kinds are star, reaction, rating and legacy verdict; unknown facts remain null or empty,
not invented.

| Origin | Source and limits |
| --- | --- |
| `phone_shortlist` | Explicit local `--phone-db` has current controls, not history. Export can also read a previously saved `hosted-feedback.json`; it does not fetch or update that file. Unstarred or cleared reactions produce no event; current controls share the row update time. Source version, result link and written reason are unavailable. |
| `local_ratings` | Profile `review_db` supplies five-level rating history and saved version/result links when present. |
| `legacy_review` | `--legacy-db` defaults to `data/review.sqlite3` under the installation root. Only profile-assigned rows are included unless `--include-unassigned` is set; unassigned rows do not prove authorship. Version and result links are unavailable. Verdicts are good/bad/unsure. |

Missing files or rating/legacy tables produce no events; malformed stores fail. No adapter initializes or migrates
stores. Reasons may be private: keep output ignored. JSON goes to stdout unless `--out PATH` is supplied; counts go
to stderr. File output is atomic and owner-only; unrelated files, links and other profiles' exports cannot be
replaced. Remote transfer is not implemented.
