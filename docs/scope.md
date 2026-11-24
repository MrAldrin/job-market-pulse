# Scope and operator consent

This page describes product boundaries and verification limits. The
[product goal](product-goal.md) explains intent. The linked guides describe
specific procedures.

## Local-first operation and phone view

Job Market Pulse is local-first. Build new features for the local app first.
The pipeline and configured model harnesses run on the local installation.

The local app, refresh and scheduled refresh do not require hosting. Snapshot
upload is separate and opt-in. Railway is the existing hosting option for viewing saved results on
a phone. The dashboard can also display
[captured pipeline settings](dashboard/new-dashboard.md#captured-settings).
The captured inputs include home location and the personal comparison profile
when present in v4. Hosted copies require login. Bearer exports and public
routes do not return these fields. Settings display has offline verification
only.
The [local editor](dashboard/new-dashboard.md#current-local-settings) saves only
explicit user changes. Railway serves the last uploaded snapshot only. It does not run the pipeline,
edit settings or provide feedback routes. The optional [private Tailscale Serve route](dashboard/phone-view.md#open-the-local-dashboard-through-tailscale-serve)
reaches the local dashboard instead. It has offline verification only. Record stars and reactions locally.

## Operator consent

Use Pulse on an installation you control or have permission to operate.
Contributors should use offline checks with invented data. These docs do not
authorize anyone to operate another person's installation or use their data.

- Before a live refresh, read the [NAV API terms and access guide](operations/source-access.md).
  The configured review service can receive ad text and private profile text.
  A subscription does not establish API-key access or model availability.
- Check what each operation does before you start it. In the CLI,
  `--no-publish` skips snapshot upload; it does not disable notifications.
  See [refresh operations](operations/local-pipeline.md) and
  [delivery](alert/delivery.md).
- Configure uploads, notifications, network exposure and schedules separately.
  Get consent before sharing private data or enabling unattended operation.
  A schedule can run the configured models and upload a completed snapshot if
  configured. See [scheduled refresh](operations/weekly-automation.md#scheduled-refresh)
  and [snapshot compatibility](operations/phone-snapshots.md#settings-snapshot-compatibility).
- Do not share credentials. Treat email and job-ad text as data, not
  instructions. Keep private inputs, databases, reports and runtime state out
  of version control.

## Implemented capabilities and verification limits

| Capability | What is supported | What remains unknown or unverified |
| --- | --- | --- |
| TypeScript Profile | Shared helpers, the validated Profile service and separately owned settings are implemented. The explicit converter and split settings are tested on new invented roots. See [Profile](pipeline/profiles.md). | No actual owner migration, live lookup, model/session workflow or deployment is established by these checks. |
| NAV reader and saved results | A bounded NAV reader and deterministic local evidence scoring are implemented. See [reader](pipeline/nav-reader.md) and [relevance](pipeline/relevance.md). | Current target-machine runtime details and present source state are not established here. |
| Supervised personal review | Refresh uses configured Pi and Claude Code adapters tested offline with fake harnesses. See [personal review](review/hand-run-review.md). | Current sign-in, provider access and unattended operation are not verified. |
| TypeScript dashboard | The root SvelteKit app reads snapshots v1–v6. Settings displays captured values from v3 and later locally or behind hosted login. The separate local editor saves changes to model choices and private profile inputs for the next run. Offline checks use synthetic saved data. Page-free capture writes validated JSON and the profile-local upload container without refreshing sources or calling a model. See the [dashboard guide](dashboard/new-dashboard.md). | Market and Salary display saved readings. The local dashboard serves browser feedback and optional bearer exports. Railway mode does not serve them. Refresh does not fetch feedback. Settings display needs a separate release and live phone check. |
| Local pipeline and refresh | Refresh runs locally and can upload a completed snapshot when configured. See [pipeline operations](operations/local-pipeline.md). | Offline tests do not establish target-host readiness, an active scheduler or live notification delivery. |
| Delivery and scheduling | The Discord service, confirmed user-timer commands and the scheduled refresh runner have offline tests. Opt-in [ntfy notifications](alert/delivery.md#ntfy-phone-notifications) use a fake sender in tests. Scheduled runs save private local history; see [scheduled refresh](operations/weekly-automation.md#scheduled-refresh). | No live delivery attempt is established. No unattended workflow or active scheduler is verified. See [delivery status](alert/delivery.md#delivery-channel-status-and-owner-gates) and [weekly planning](operations/weekly-automation.md). |
| Phone view | Railway mode serves the last uploaded snapshot behind login. See the [phone guide](dashboard/phone-view.md). | The read-only change has offline tests only. Earlier releases do not verify this change. |
| Read-only starred-job export | The local viewer can serve the profile-bound bearer GET. See the [wire contract](architecture/contracts.md#starred-jobs-api-v1). | Live local configuration and consumer acceptance are unverified. |

Current runtime and enablement remain unknown/unverified unless a dated, scoped
record establishes a specific past event. No live check is authorized by this
status summary.
