# ntfy notifications

Pulse sends automatic notifications only when the owner turns them on in [local settings](local-settings-api.md).
The sender makes one HTTPS POST to `https://ntfy.sh` with JSON. It does not
follow redirects or retry. It waits at most five seconds. A 2xx response is
an acknowledgement, not proof of receipt.

| Trigger | JSON fields |
| --- | --- |
| Successful refresh with newly exceptional jobs | `topic`, fixed Pulse title with match count, `message` with job titles and employers, and `click` with the configured HTTPS dashboard URL |
| Failed scheduled attempt | `topic`, fixed Pulse title and fixed message. No run details or link. |
| Explicit **Send test** | `topic`, fixed Pulse title and fixed test message. No run details or link. |

The topic is a routing secret, not part of the message text. The sender
does not print the request or response. The message never uses fit reasons,
evidence, profile text, job URLs, tokens, paths or raw errors. A new match
is an open exceptional job ID absent from the previous snapshot's open
exceptional set. With no previous snapshot, all current open exceptional
jobs are new. If a snapshot exists but cannot be read, Pulse skips the match
notice. Long messages show a count for any matches that do not fit.

Pulse compares saved snapshots around the run. A scheduled success also
needs a verified completion and saved successful history. Skipped due
checks and process interruptions do not send. Notification failure does
not change the run result. A snapshot saved before an upload failure can still
be the baseline for the next run. Pulse does not save delivery history or replay
a notice if delivery fails.

See [operation and privacy limits](../docs/alert/delivery.md#ntfy-phone-notifications).
