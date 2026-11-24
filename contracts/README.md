# Brick contracts

Each brick boundary uses one versioned data contract. This directory holds
readable JSON Schemas (draft 2020-12) and synthetic examples. Python validators
use only the standard library. The schemas also describe the data for
TypeScript consumers; they do not replace runtime validation.

The internal [interview session](interview-session.md) is a process/data
boundary, not a versioned brick document or registry entry.

## File pattern

For a contract named `<name>`:

- `contracts/<name>.schema.json`: the JSON Schema.
- `contracts/fixtures/<name>.example.json`: a valid synthetic document.
- `src/lib/contracts/`: the owning brick's Effect Schema validator.
- `tests/`: valid and invalid cases for the owning Schema.

Contract validation is pure. It does not read a database, access the network or start a model. Reject unknown keys unless the contract explicitly permits them. Versioned documents use `schema` and integer `schema_version`. Timestamp fields use the contract's calendar format with a time zone; prefer UTC for output.

The existing [candidate manifest](../docs/architecture/contracts.md#candidate-manifest-contract)
uses its own builder and review checks in `src/lib/server/filter/manifest.ts`. Its
synthetic fixture is `fixtures/manifest.example.json`. It has no separate
schema or registry entry; the page documents this older boundary.

The existing [shortlist feedback HTTP API](../docs/architecture/contracts.md#shortlist-feedback-api)
has a wire example in `fixtures/feedback_api.example.json`. It is not a versioned
brick document and has no schema header or registry entry. The same contract
page documents the local server's injected storage interface and wire differences.

The external [starred-jobs API v1](../docs/architecture/contracts.md#starred-jobs-api-v1)
has a frozen wire example in `fixtures/starred_jobs_api.example.json`.
Like the feedback HTTP example, it has no `pulse.*` schema header or registry
entry. Its exact contract is owned by the sibling job-applications repository.

The [snapshot v1 reference](../docs/architecture/contracts.md#snapshot-v1-contract) explains
all display fields, output paths, privacy limits and validation. Its schema and
synthetic example are `snapshot.schema.json` and `fixtures/snapshot.example.json`.
The TypeScript runtime Schema also owns the explicit [Market-history v2](../docs/architecture/contracts.md#snapshot-v2-market-history)
[settings v3](snapshot-v3.md), [private review inputs v4](snapshot-v4.md) and
[run funnel v5](snapshot-v5.md) and [job distance v6](snapshot-v6.md) variants.
The JSON Schema stays a v1 reference.

The [local feedback events API](feedback-events-api.md) returns the existing
feedback-events v1 document for current phone controls. Its fixture is
`fixtures/hosted_feedback.example.json`. It does not change the starred-jobs API.

The [local settings API](local-settings-api.md) is the unversioned loopback
boundary between the editor and Profile. Its Effect Schema owns the wire shapes.

The [local run API](local-run-api.md) is the unversioned loopback boundary for
starting a selected dashboard refresh and reading its status. It also describes
the orchestration progress events used by the server.

The [ntfy notification contract](ntfy-notifications.md) defines the outbound
messages and their trigger gates.

## CLI output

[`pulse doctor --json`](../docs/operations/short-cli.md#check-setup) emits one
[doctor v1 document](doctor.schema.json) on stdout. The [synthetic example](fixtures/doctor.example.json)
shows the shape. The Effect Schema owns the wire format. Use `id`, `required`
and `ok` for decisions. `message` and `fix` are for people. A passing check has
no fix. Do not assume a check ran if its ID is absent.

## Shared utility interfaces

The [fixed Oslo utility](fixed-oslo-utility.md) defines the pure time-zone
interface used by Profile and orchestration. It is not a wire document and has
no JSON Schema or registry entry.

## Import boundaries

Validators use shared contract helpers and may compose the schemas they embed. They must not import pipeline implementations. Dashboard result views use validated snapshot data, not Snapshot producers or private pipeline stores. See the [brick map](../docs/architecture/bricks.md).

## Versions

- Adding an optional field keeps the version. Update the schema, validator
  and tests together before producers send the field.
- Removing or changing a field raises the version.
- Validators accept only their declared supported versions. Keep failures
  explicit; do not silently convert an unsupported version.

## Fixtures

Fixtures are synthetic. Never copy private or live data into this directory.
Use invented people, employers, titles and listing IDs. Test fixtures do not
establish a working live integration.

Add each validator to `pulse.shared.contract_registry.CONTRACTS`. The registry
and conformance checks are implemented. Each registered entry must have its
schema and fixture. Run `bun run test:oracle` for the retained offline comparisons. Add every new Python module to
`docs/architecture/module-map.toml` and regenerate its Markdown page.
