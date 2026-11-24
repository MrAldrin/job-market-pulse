# Quickstart

## Try the dashboard

To try invented jobs without a profile or credentials, use Bun 1.4.4
and Node.js 22.17 or newer. Run these commands from the checkout. The
dependency install can contact package registries. If you already ran setup,
use just the last command.

```bash
bun install --frozen-lockfile
bun run build
bun src/cli/pulse.ts demo
```

Open the local URL printed in the terminal. Press `Ctrl+C` to stop the demo.
The demo does not contact external services or save feedback.

## Set up your profile

From a terminal in a fresh checkout, run:

```bash
bun run setup
```

Use Bun 1.4.4 and Node.js 22.17 or newer on `PATH`. Check with `bun --version`
and `node --version`. Setup checks both versions before it installs anything.

Setup installs dependencies from the frozen lockfile, builds the dashboard,
runs [Doctor](operations/short-cli.md#check-setup), then starts the
[setup wizard](operations/setup-wizard.md). The dependency install can contact
package registries. Doctor reports missing setup before the wizard starts.
You can run setup again. The wizard displays saved settings and asks before
it changes them. It can save private answers for resuming setup. Keep
`local_only/` out of version control. If you did not [link the CLI](operations/short-cli.md#one-time-setup),
use `bun src/cli/pulse.ts` in place of `pulse` in the wizard’s next steps.

Quick postcode setup contacts Kartverket. The guided interview can send your
answers to the configured AI service. Choose the short form or defer the
interview to avoid a model call during setup.

On Linux, the wizard asks before it sets up Electron and adds the app menu
entry. Press Enter to skip it. The menu opens the dashboard for the selected
profile even before the first refresh. Setup does not run a refresh, upload a
snapshot or enable a timer.

Run `bun src/cli/pulse.ts status` to check setup and saved results. The first
refresh can create the Source database. Status does not test live access.

## Before the first refresh

Complete the [profile and source setup](pipeline/profiles.md), read
[NAV access before your first refresh](operations/source-access.md), and check
access to the configured review model. A saved profile does not prove that
either service is ready.

Open the dashboard and select **Run**, or follow the
[CLI refresh procedure](operations/local-pipeline.md#owner-started-refresh)
and run `bun src/cli/pulse.ts refresh --no-publish`. Both save the first
snapshot locally without uploading it. A refresh can contact NAV, location
services and the configured model service. Hosting, upload, schedules and delivery have separate
[approval gates](scope.md).

