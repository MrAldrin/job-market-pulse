# Manual operations

This guide covers local operation and checks before deployment. See
[scope](../scope.md) for current capabilities and verification limits.

## Module map renderer

See the [module map](../architecture/module-map.md) and its TOML source.

## Setup and manual runs

The examples use `<repo-root>` as a placeholder for the checkout path. If installing elsewhere, replace
`<repo-root>` with the chosen absolute project path consistently.

```bash
cd <repo-root>
bun install --frozen-lockfile
```

For bounded source operations and database selection, see the [NAV reader](../pipeline/nav-reader.md).

## Writer-lock coordination, backup, and recovery

Stop all readers and writers before database maintenance. Locks are cooperative
and do not cover every process. Keep database backups private.

Use `pulse sqlite_backup --db FILE --output FILE` to create a private backup.
The output directory must exist and the output file must not exist. The backup
omits cached ad text. See [Pulse CLI](short-cli.md#daily-commands).

### Manual restore

There is no restore command. To restore a database from a backup:

1. Stop the timer, and check that no `pulse` command runs.
2. Keep a copy of the current database, then copy the backup over it. If
   `-wal` or `-shm` files remain next to it, stop and inspect them first.
3. Start the timer.

A display snapshot is not a database backup.

## Runtime verification and deployment gate

Before deployment, check on the target: Linux distribution/version (`cat /etc/os-release`), architecture
(`uname -m`), the pinned Bun version (`bun --version`), free memory (`free -h`) and peak
memory during a bounded run. Verify the runtime identity, private filesystem permissions,
project access, writable data/snapshot paths and single-writer support. Development results do not establish
these target facts.

Then verify project setup, offline database access, one owner-approved bounded online run, cursor
continuation, backup/restore, and resource use. Inspect the saved source check time and errors. A weekly snapshot
cadence is separate from source synchronization freshness: snapshot capture alone does not satisfy update or
removal freshness needs. Agree an adequate refresh policy, runtime permissions, resource limits, recovery
procedure, and overlap protection before seeking approval for any scheduling. Do not install or enable a timer
as part of this manual preparation.

## Activation gates

See [scope](../scope.md) for operator consent. Prototypes are not live integration. Before a future live step, verify
runtime OS, Bun, memory, scheduler, filesystem access, end-to-end manual run,
caught-up state, history, limits, backup, recovery, monitoring and timezone.
A subscription does not establish API access.

Before activation, test passive quiet and active expansion without changing hard limits, fail-closed
missing/stale inputs, nonduplicating replay, separate profiles, private safe HTML and distinct
staged/failed/uncertain/delivered states. Review the configured model disclosure, source rules and
prompt-injection validation. A live first delivery additionally needs independent review, separate owner
approval, secret checks and recipient verification. A phone route needs host and access policy checks. Do not
invent another person's profile or overwrite private files.

## Supervised browser checks

Use a separate browser profile for an approved account check. Verify the
signed-in identity. Keep login codes out of logs and do not change account
settings without approval. An interactive check does not authorize unattended
mailbox or listing access.

## Private-value publication guard

Run `bun scripts/check-private-values.ts` from the checkout. This is the same
command the Private values workflow runs. It checks current file contents for
paths listed by jj (which snapshots local changes) or the Git index. It does not
check history or read staged Git blob contents. For an exact release review,
assemble only the approved export files in a separate directory and run:

```bash
bun scripts/check-private-values.ts --release-dir /path/to/staged-release --require-list
```

Keep `local_only/config/private-strings.txt` in the source checkout, not in the
release directory. Release mode rejects `.git`, `.jj`, `.beads`, and
`local_only` entries. The optional local pre-commit hook uses `--require-list`
and fails if the owner list is absent. CI has no owner list and uses only the
tailnet hostname and Railway URL rules.
Use one literal value per line. Blank lines and lines that start with `#` are
ignored. The check matches whole tokens without regard to case. Keep this list
ignored. Do not copy it to CI, logs, or issues.

Results show paths, line numbers, and rule IDs, not matched values. Line 0
marks a name match; the check hides that path. It scans symlink target text
without following the link. It counts but cannot inspect non-UTF-8 or
NUL-containing bodies. Exit status 1 means findings; 2 means an input error.
Review skipped bodies, symlinks, and the release diff separately. Do not bypass
a failed check.

Use reserved `.example` names in tracked examples. Tests build
production-shaped invented names at runtime in temporary inputs. There is
no fixture path or hostname allowlist.

The workflow is disabled on the private repository. After local verification,
only the owner can enable it on the intended repository with
`gh workflow enable "Private values"`. Local checks do not verify GitHub CI.
