# Railway deployment

Railway serves a read-only copy of the last uploaded snapshot. Use the
[phone guide](../dashboard/phone-view.md) to view it and the
[snapshot guide](phone-snapshots.md) to capture and upload saved data. The
read-only change has offline verification only. It is not deployed by this work.

## TypeScript build

The Dockerfile at `deploy/railway/Dockerfile` builds the SvelteKit app. It runs
as UID/GID 10001 in Railway mode. The app reads `/data/digests.sqlite` and
exposes public `/healthz`. It has no upload endpoint.

## Hosted dashboard

After sign-in, the app serves saved data under `/app/`. Host and session
checks protect pages and data. Generated assets and health are public. The app
reads the newest saved JSON on each request. Missing JSON returns 404; an invalid
store returns 503. Snapshot upload does not require a viewer restart.

## Login

Set `DIGEST_VIEW_USER`, `DIGEST_VIEW_PASSWORD` (at least 16 characters) and `DIGEST_VIEW_SESSION_SECRET` (at least 32 characters) in the environment. There is no password-derived signing key. HTTPS is required. Login sets the signed `jmp_session` cookie with `HttpOnly; Secure; SameSite=Lax` and a 30-day expiry. Secret rotation ends existing sessions; a password change alone does not.

Login and logout use same-origin form POSTs. Missing, wrong or null Origin can return 403 before the handler. Ten failed logins per address within 15 minutes trigger a temporary limit. Railway overwrites `X-Real-IP` (checked 2026-11-18), so a forged header does not bypass the limit.

## Build and deploy

Only the owner deploys. Follow the [viewer-first release order](phone-snapshots.md#settings-snapshot-compatibility).
Set `RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile` because Railway reads
`railway.toml` only at the upload root. Deploy with
`railway up --service digest-view --ci` from a clean checkout of `main`.
Do not use data-only `pulse publish` to deploy code.

## Feedback storage

Railway mode does not read, create or write the feedback database. It ignores
old feedback and bearer configuration. Leave any existing hosted database
untouched for rollback. Give feedback in the [local dashboard](../dashboard/new-dashboard.md#local-feedback),
also when you access that dashboard over Tailscale.

## Read-only starred-job export

Railway no longer serves `/api/v1/starred-jobs` or
`/api/v1/feedback-events`. Both return 404 at the application handler.
A consumer that points at Railway cannot pull stars or reactions after this
release. A 404 is not an empty feed. The [starred-jobs](../architecture/contracts.md#starred-jobs-api-v1)
and [feedback-events](../../contracts/feedback-events-api.md) wire formats
remain unchanged on a configured local viewer.

## Release and manual acceptance

After approval, keep the last known-good viewer, compatible snapshot, mount
and login secrets intact. Check health, sign-in and saved snapshot load on the
phone. Check that feedback controls are absent and the old feedback routes
return 404. Verify the existing snapshot before any new upload. Offline tests
do not establish live phone access or release acceptance.
