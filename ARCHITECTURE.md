# Architecture

The root Bun package contains the Pulse CLI, pipeline services and SvelteKit dashboard. The [brick map](docs/architecture/bricks.md) defines ownership; the [contracts](docs/architecture/contracts.md) define data that crosses boundaries. The [scope](docs/scope.md) describes operator consent and verification limits.

## Repository map

- `src/cli/`, `src/lib/server/`, `src/lib/contracts/`: CLI, pipeline and data contracts.
  See the [module map](docs/architecture/module-map.md) for ownership.
- `src/routes/`, `src/lib/`: dashboard routes, components and shared code.
- `tests/`: offline checks with synthetic or sanitized data.
- `scripts/`, `config/`, `deploy/`: helpers, configuration and deployment files.
- `docs/`: [operating guides and references](docs/index.md).

## Run and display

Follow the [local-first design and hosting policy](docs/scope.md#local-first-operation-and-phone-view).
The same dashboard build displays
[captured settings](docs/dashboard/new-dashboard.md#captured-settings) locally
and in hosted mode. A separate [local editor](docs/dashboard/new-dashboard.md#current-local-settings)
updates current settings through Profile. It can list Pi candidates and run a
short model test on explicit request. The selected local dashboard can also
start a refresh through the [local run API](contracts/local-run-api.md), but
only after the user confirms. It does not upload the snapshot. These controls
have offline verification only.
The [Linux desktop shell](docs/operations/short-cli.md#linux-desktop-window)
starts the same local dashboard CLI and supervises its shutdown. It does not
read profile or snapshot files itself. The AppImage includes compiled Pulse and
dashboard executables. Its launcher routes terminal commands straight to Pulse.
Bundled resources stay separate from writable installation data. The Windows
path adapter uses `%APPDATA%/job-market-pulse` for installation settings and
`%LOCALAPPDATA%/job-market-pulse` for profiles and run data. The Windows desktop,
CLI and server use parent-pipe closure for graceful shutdown. Windows writer
locks hold a nonsharing file handle. Windows refresh checks NTFS permissions
before source work and again before Judge opens its database. It refuses
permission checks that it cannot verify. POSIX Judge permission checks are
unchanged. Offline Windows CI tests private storage and synthetic refresh.
The [Windows tester guide](docs/operations/short-cli.md#windows-refresh-and-failure-reports)
explains the verification limits, supported harness and reporting steps.
Railway serves the last uploaded snapshot. It does not run the pipeline, edit
settings or serve feedback routes.

- [Profile](docs/pipeline/profiles.md) validates one installation and profile. TOML settings have one owner per file.
- [Source](docs/pipeline/nav-reader.md) saves bounded NAV changes and location evidence in SQLite. [Filter](docs/pipeline/personal-pipeline.md) makes deterministic admission decisions. Geography, occupation and explicit exclusions apply before model review.
- [Judge](docs/review/hand-run-review.md) uses configured Pi or Claude Code harnesses. It binds accepted results to saved source and personal inputs. [Select](docs/alert/digest.md) applies mode, evidence and freshness. Market counts describe only the monitored population.
- [Snapshot](docs/architecture/contracts.md#snapshot-v3-settings) captures saved facts and selected inputs in versioned JSON and a private upload container. The [dashboard](docs/dashboard/new-dashboard.md) reads snapshots for saved results, not private pipeline tables. Viewing a snapshot never starts pipeline work or a model call.
- [Alert](docs/alert/delivery.md) has two paths. Discord uses staged digests; staging does not send. Opt-in ntfy notifications compare saved snapshots after refresh and send a fixed message for failed scheduled attempts.
- [Feedback](docs/review/review-feedback.md) separates saved stars, reactions and five-choice ratings. Local controls use a separate SQLite store. A bearer export permits reads, not browser writes. Calibration proposals do not apply profile changes.

## Runtime and safety

[Refresh](docs/operations/local-pipeline.md) holds the installation lock through the local run and optional data-only publish. The [timer commands](docs/operations/weekly-automation.md) do not establish that a timer is active. The hosted build requires HTTPS, password login, a signed session cookie and environment secrets; see [Railway](docs/operations/railway.md).

Treat ad and email text as untrusted data. Bound network access, keep private text and credentials out of version control, and distinguish offline tests from live evidence. Offline checks do not establish runtime readiness, credentials, deployment or phone acceptance.
