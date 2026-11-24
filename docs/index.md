# Documentation hub

Start with [Install](../README.md#install) or the [quickstart](quickstart.md).
See [Build the documentation site](../CONTRIBUTING.md#build-the-documentation-site)
to render these guides locally.

## Start here

- [Quickstart](quickstart.md): try the demo and set up your own profile.
- [Pulse CLI](operations/short-cli.md): everyday commands, Bash/Fish setup and
  the coverage and limits map. See the [Windows installer](operations/short-cli.md#windows-desktop-installer)
  for the offline owner checklist.

## Top level

- [Writing style](writing-style.md): project prose rules, technical terms and reference limits.
- [Product goal](product-goal.md): intended user outcome and product direction.
- [Pipeline bricks](architecture/bricks.md): the three layers, data boundaries and main modules.
- [Snapshot v1 contract](architecture/contracts.md#snapshot-v1-contract): saved display fields,
  privacy, versions and offline validation.
- [Setup wizard](operations/setup-wizard.md): questions, private files, resume and next steps.
- [Project glossary](architecture/glossary.md): sourced definitions for overloaded project terms.
- [Module map](architecture/module-map.md) and its [TOML source](architecture/module-map.toml):
  server, contract, CLI and shell ownership.

## pipeline/: sources, scoring and profiles

- [Follow a Pulse refresh](pipeline/refresh-flow.md): run stages, filters, settings and count units.
- [NAV feed access and terms](pipeline/nav-feed.md): source contract and access notes.
- [NAV reader](pipeline/nav-reader.md): reader bounds, database selection and operation.
- [Geography](pipeline/geography.md) and [location resolution](pipeline/location-resolution.md):
  hard-radius and address-evidence rules.
- [Deterministic relevance](pipeline/relevance.md): local evidence and ordering.
- [Market counts](pipeline/market.md): aggregate history, taxonomy and interpretation.
- [Profiles](pipeline/profiles.md): private profile layout and policy contract.
- [Fit contract](pipeline/fit-contract.md): source-bound assessment requirements.
- [Personal pipeline](pipeline/personal-pipeline.md): prepare, preview and stage supplied
  reviews.
- [Historical review import](pipeline/historical-review-import.md): provenance-checked
  imports.
- [Observation history](pipeline/observations.md): minimized capture and profile scope.
- [Pipeline seams](pipeline/pipeline-seams.md): implemented replaceable interfaces and
  their limits.

## alert/: digest and delivery

- [Digest behavior](alert/digest.md): local preview and market context.
- [Delivery reference](alert/delivery.md): outbox, Discord and live approval gates.

## dashboard/: viewing results

- [UI overview](dashboard/ui-overview.md): page purposes, agreed goals and implementation gaps.
- [Optional phone view](dashboard/phone-view.md): Tailscale Serve or hosted Railway
  and common errors.
- [Local Svelte dashboard](dashboard/new-dashboard.md): build and serve the snapshot app
  with saved jobs and reviews. Market and Salary display saved readings.
- [Dashboard acceptance checklist](dashboard/acceptance-checklist.md): owner checks on desktop and phone
- [Shortlist feedback API](architecture/contracts.md#shortlist-feedback-api): authenticated
  read/write shapes, CSRF checks and error results.

## review/: manual review and feedback

- [Personal review](review/hand-run-review.md): preparation, model settings,
  saved state and bounded manual review.
- [Review feedback](review/review-feedback.md): personal-fit calibration and the
  separate legacy relevance store.
- [Feedback events](architecture/contracts.md#feedback-events): the combined read boundary for retained feedback origins.

## operations/: running and deploying

- [NAV access before your first refresh](operations/source-access.md): terms, token handling,
  request limits and what the reader keeps.
- [Browser access](operations/operations.md#supervised-browser-checks): supervised browser checks.
- [Activation procedure](operations/operations.md#activation-gates): operational checks before a live step.
- [Portable manual operation](operations/operations.md): local commands and runtime checks.
- [Environment](operations/operations.md#activation-gates): known machine context and unknowns.
- [Private-value guard](operations/operations.md#private-value-publication-guard): redacted local and CI checks
  before publication, with limits for jj, history and missing private lists.
- [Weekly planning](operations/weekly-automation.md): timer commands and scheduled refresh limits.
- [macOS setup](operations/macos-setup.md): checkout, browser dashboard and LaunchAgent checks.
- [Pulse CLI](operations/short-cli.md): checkout module commands, local default
  profile, separate refresh, data publishing, code deployment and local status.
- [Local one-command pipeline](operations/local-pipeline.md): sync, locations, review
  and snapshot, with retry limits.
- [Publish a phone snapshot](operations/phone-snapshots.md): saved-data capture,
  upload and technical reference.
- [Railway deployment](operations/railway.md): hosted viewer, login, storage,
  deployment and acceptance checks, including the
  [read-only starred-job export](operations/railway.md#read-only-starred-job-export).

