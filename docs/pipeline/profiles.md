# Private profiles

Select an installation root and a profile ID. Use [the setup wizard](../operations/setup-wizard.md) to create or resume a profile. Use an absolute path for another user's installation. A profile is not ready until its required settings and narrative are valid.
Before your first refresh, read the [NAV terms and access guide](../operations/source-access.md).

| File under `local_only/profiles/<id>/` | Owner and purpose |
| --- | --- |
| `profile.toml` | Profile: paths, mode, cadence, freshness and review limits |
| `filters.toml` | Filter: geography, occupation and title/employer exclusions |
| `screen.toml` | Screen: title patterns and version metadata |
| `judge.toml` | Judge: preferred job terms |
| `profile.md` | Profile: private narrative used by Judge |

The installation-wide `local_only/models.toml` selects the model, harness, effort and batch size for each model step. One file owns each setting. The Profile service validates the selected files and gives typed input to consumers. The legacy preferences path can remain in the profile as compatibility metadata; normal loads do not open it. Setup writes split files. The split-settings library converts explicitly selected legacy inputs without overwriting them; the retained CLI does not expose the converter.

Use calendar timestamps such as `2026-11-18T09:00:00+01:00`. Schedule anchors also accept saved calendar and week dates. Schedule decisions use Europe/Oslo, not the host timezone.

## Installed paths on Linux

A checkout keeps its existing layout. In installed mode, Pulse uses two user directories:

- `$XDG_CONFIG_HOME/job-market-pulse` holds installation settings such as `local_only/pulse.toml` and `local_only/models.toml`. The default base is `~/.config`.
- `$XDG_DATA_HOME/job-market-pulse` holds `local_only/profiles/`, snapshots, and `data/` for the shared database and run locks. The default base is `~/.local/share`.

Pulse ignores relative XDG values. Setup creates the user directories when it saves files, not during a dry run. The installed app reads the default rules, taxonomy and interview files from its bundle. It does not save user files there. These paths have offline checks; they do not establish AppImage availability.

## Policy

Passive mode selects exceptional matches only. Active mode also permits strong matches. Neither mode relaxes geography or other hard limits. See [personal review](../review/hand-run-review.md).

## Filesystem limits

Profile setup uses private directories and files. Keep narrative, configuration and databases out of version control. The path checks are for a trusted local machine, not isolation from another local process.
