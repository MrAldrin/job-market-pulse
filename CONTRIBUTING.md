# Contribute to Job Market Pulse

- Follow the [quickstart](docs/quickstart.md). Use the Bun version in
  `package.json` and install with `bun install --frozen-lockfile`.
- Keep changes small. Explain the problem, what changed and how you checked
  it. Follow the [architecture](ARCHITECTURE.md) and update affected references.
- Run `bun run check`. For dashboard changes, run the relevant
  `bun run test:slow` checks with the pinned local Chromium cache.
- A Git-only clone cannot run `bun run test:smoke`: the desktop smoke test
  needs a jj workspace. The saved-output check (`bun run test:oracle`) works
  without the historical Python recorder, which is not shipped.
- Use invented data in examples and tests. Do not submit profiles, job or
  email samples from your account, credentials, databases or private logs.
  Keep local settings under the ignored `local_only/` directory.
- Keep existing third-party license notices with the files they cover.

## Build the documentation site

With [Zensical](https://zensical.org/docs/) 0.0.73 installed, run `zensical build`
from the checkout root. The result is in the ignored `site/` directory.
Check the build output for link and anchor warnings.
