# Publish a phone snapshot

Railway upload is optional. To opt in to upload after a successful
`pulse refresh`, configure the destination in `local_only/publish.toml`.
Without that file, refresh does not look for the Railway CLI or try to upload.
`pulse refresh --no-publish` ignores the file and keeps the snapshot local.
For [scheduled upload](weekly-automation.md#scheduled-refresh), the file must
also specify a volume.

Use `pulse publish` for a separate upload of saved data. It previews the
operation and requires `--apply` to upload. For snapshots v1–v3, this explicit
command can use the linked Railway project without a settings file. All upload
paths still apply the gates below. Upload is separate from deployment.

Snapshot capture uses saved results and the selected pipeline settings. It does not refresh the source, make model calls or send alerts. It writes validated JSON and a private profile-local upload container. Full captures write [snapshot v6](../../contracts/snapshot-v6.md). Keep the snapshot and its SQLite container private.

Railway displays only the last uploaded snapshot. Refresh does not fetch
feedback. Save stars and reactions in the [local dashboard](../dashboard/new-dashboard.md#local-feedback).

## Settings snapshot compatibility

V6 has offline verification only. Older viewers cannot read it. Strict viewers
that predate v4, re-judge fields or the notification on/off field also reject
snapshots that contain those fields. Update the viewer before publishing newer
snapshots. Use this order:

1. Keep a private copy of a snapshot that the current viewer can read.
2. With separate deployment approval, deploy a v6-capable viewer before changing
   the publisher. Verify it with the existing snapshot before any v6 upload.
   Check that the Railway copy is read-only. Follow the [deployment gates](railway.md).
3. Obtain explicit owner approval to upload the actual home location, job
   distances and comparison profile to the selected viewer. Only then set
   `allow_private_inputs = true` and the matching `profile` in the ignored
   `local_only/publish.toml`. Also set `project`, `environment`, `service`, and
   `volume` to the Railway UUIDs of the approved destination. Use IDs, not names.
   V4 and later pass these IDs to Railway and do not use the linked project or
   prompt for a volume. Differing service or volume overrides block upload.
   This gate applies to manual, refresh, and scheduled uploads. It is off by default.

Until approval and verification, leave the upload file absent or use
`pulse refresh --no-publish` for local capture. Do not switch a scheduled publisher to a runner that writes v6 before
viewer verification. The shared upload gate refuses v4 and later before transfer
when the private-input opt-in is off. It does not change uploads of v1 through v3.

To roll back, pause uploads, remove the opt-in and restore a snapshot the
previous viewer can read. Leave any old hosted feedback files untouched.
