# Alert delivery

## ntfy phone notifications

The owner can opt in on the local **Settings** page under **Phone notifications**
or in a terminal with `pulse init --step alert`. Setup and saving do not send.
Use a random topic of 24 to 64 letters, digits, hyphens or underscores. Add it
to the ntfy app on your phone. Anyone who knows the topic can read or post.
Do not paste the topic into a URL or share it in screenshots or logs.

Pulse keeps the topic, on/off setting and dashboard URL in the installation's
private `local_only/ntfy.toml`. Enter a dashboard HTTPS URL that works on your
phone. Do not include credentials, a query or a fragment. This value supplies
a link in the notification; it does not configure access to your dashboard.
For the private Serve route, use the [phone URL](../dashboard/phone-view.md#open-the-local-dashboard-through-tailscale-serve).
Captured settings show only on/off. Doctor reports only topic presence.
On Windows, Pulse checks the NTFS permissions of the settings directory and
existing file before it reads the topic. It also checks inheritance and the
staged file before it writes settings. If Pulse cannot verify private access,
it refuses the save or skips the send. Native Windows behavior is not verified.

The [notification contract](../../contracts/ntfy-notifications.md) defines
the short messages and the run gates. This opt-in is separate from snapshot
upload; `--no-publish` does not turn notifications off. To test, use **Send
test** on the local Settings page after saving a topic. This action sends one
message even when automatic notifications are off. It never starts a refresh.

Get owner approval before any live attempt. Offline tests use a fake sender.
Live delivery and phone receipt have not been verified.

## Staged Discord outbox

The TypeScript outbox stages private digest artifacts and a fixed redacted
preview in a profile-bound SQLite ledger.
Staging, configuration and preflight do not send. Offline checks do not
establish live Discord delivery, credentials or recipient receipt.

## TypeScript service boundary

- `src/lib/contracts/alert.ts` defines staged records, items, states and safe
  approval summaries. Input remains the staged digest and outbox, not snapshot
  JSON. The accepted Select service supplies digest content.
- `alert/outbox.ts` exposes `DeliveryOutboxLive(options, profileId)`. The
  `storageRoot` and optional `databasePath` select separate artifact and ledger
  locations. Reads preserve absence: list/history return empty, an invalid ledger fails, and a missing
  selected digest fails without creating a store. Only explicit writer operations
  can initialize schema v2. Existing profile bindings and rows stay unchanged.
- `alert/service.ts` exposes `AlertDispatchLive(profile, outbox)`. Preflight is
  read-only. Approved dispatch rechecks configuration, artifacts and state under
  the injected `AlertProfileLock`, then commits `uncertain` before one attempt.
  Orchestration supplies the inter-process `.stage.lock`; no unlocked default exists.
- `alert/config.ts` reads explicit Discord settings from the private profile file
  or the selected environment-only source. The Discord channel must be selected;
  omitted transport names do not silently become Discord. Secret URLs use
  `Redacted`; results and errors contain safe codes and fingerprints only.
- `alert/discord.ts` owns the fixed preview, mention suppression, `wait=true`,
  bounded numeric-message-ID acknowledgement and retry hint. The explicit Effect
  HTTP service uses a narrow native HTTPS adapter to distinguish connection
  failure from uncertain submission. There is no redirect or automatic retry.
- `alert/artifacts.ts` uses private files and installs artifacts without
  overwriting existing files. New private MIME uses UTF-8/base64 and has no
  recipient headers. No private MIME transport is registered.

A confirmed acceptance alone updates notification history. Staging, preparation,
a failed attempt and an uncertain attempt do not mean delivery. Delivered and
uncertain digests cannot be retried. A definitive rejection permits a separately
approved new attempt. A second Select run uses confirmed versions and selects no
repeat jobs.

New TypeScript stages replay byte-identically. Older MIME remains unchanged and
usable by metadata reads and retained Discord dispatch. Restaging an older MIME
encoding can fail closed because immutable bytes differ; cross-runtime MIME
byte parity and idempotent restaging are not claimed.

The offline gate checks the digest after a failed and then confirmed Discord
attempt using the synthetic `duplicate-alert` bundle. It makes no live request.

## Delivery channel status and owner gates

Discord is the only retained staged-digest transport. SMTP, generic webhooks,
The CLI has no Discord
dispatch command. Refresh does not stage or send Discord digests.

Before a first live attempt, independently review the entry point and its local checks. Get separate owner approval for one destination, the exact payload and one attempt. Verify receipt separately; a transport acknowledgement is not proof of receipt. See [activation gates](../operations/operations.md#activation-gates).

## Discord incoming webhook transport

Use the explicit profile file or environment source; do not commit secrets. The transport sends a fixed redacted preview, suppresses mentions and requires a valid message acknowledgement. Offline tests do not establish that a webhook or recipient is configured.
