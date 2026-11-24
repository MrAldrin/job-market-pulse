# Local one-command pipeline

Offline tests use synthetic inputs. They do not verify live refresh or install
a timer. The refresh wrapper can send
[opt-in ntfy notifications](../alert/delivery.md#ntfy-phone-notifications).
[Scope](../scope.md) owns permissions.

## Owner-started refresh

After optional [CLI setup](short-cli.md#one-time-setup), use `pulse refresh`, or:

```text
bun src/cli/pulse.ts --profile <profile-id> refresh
```

Refresh runs locally without Railway. If you set up [Railway upload](phone-snapshots.md),
refresh can upload the completed profile's `dashboard-snapshot.sqlite3`, never
its review DB. Use `--no-publish` to skip upload even if it is configured.
If the upload settings are invalid or the Railway CLI is missing when needed,
refresh stops before it starts the pipeline. Use `--no-publish` to run locally.
`--reset` and `--once` pass through. For v1–v3, `--volume` overrides the volume in the
ignored `local_only/publish.toml`. The flag alone does not turn on upload. For v4 and later, it must match the
[approved destination](phone-snapshots.md#settings-snapshot-compatibility).
The command ignores `output_db` and does not accept a snapshot path override.
For v1–v3, Railway prompts if no volume is set. A failed, exhausted, waiting or busy pipeline does not upload; upload failure
is separate. No code deploy, restart, delivery or schedule is run.

Refresh holds the installation lock across the pipeline and upload. It
checks the saved run ID and status before exporting. Direct snapshot writers do
not take this lock; do not run them at the same time as refresh.

Refresh does not fetch feedback from Railway. It does not modify an existing
`hosted-feedback.json` copy. Local feedback export can still read that old copy;
it is not current hosted state.

## Stages

| Stage | Operation |
| --- | --- |
| Source sync | One source lock and session, at most 100 requests, 240 seconds and 20 pages. It must catch up before detail refresh. |
| Location resolution | Resolve at most ten Filter-selected candidates and save profile-local continuation. |
| Market | Record saved counts. Failure warns but does not consume a pipeline retry. |
| Review | Check both harnesses. Use the saved freshness check, not a second feed refresh. The 200-session bound applies. Only no pending candidates advance to Snapshot. |
| Snapshot | Capture strict v6 JSON and the private SQLite upload container. If a selected digest store exists but is invalid, stop. A failed companion JSON write warns after successful SQLite capture. |

## Retry budget

Temporary failures share waits of five minutes, one hour and five hours. A fourth temporary failure exhausts the run. Use `--once` to stop without waiting. Resume starts at Source sync and checks readiness again. A readiness refusal before any stage lets the next refresh start a new run without `--reset`. If a run stops after it entered a stage, use `--reset`. This keeps the link to the prior run and keeps accepted reviews.

## State

The private `local-pipeline-run.json` records run ID, stage, status, bounded diagnostics and retry state. New terminal records also store when the run ended. Invalid saved state fails closed. The foreground runner prints a summary and a completion ID only on success.

## Locks

The runner holds installation, weekly and profile locks in that order. A competing start exits 75. Scheduled refresh passes its live installation lease; Source has a separate database writer lock. Judge holds its profile review lock through receipt persistence. Locks use Bun FFI with Linux x64 glibc; other ABIs fail closed. See [writer coordination](operations.md#writer-lock-coordination-backup-and-recovery).
