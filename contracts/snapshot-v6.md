# Snapshot v6: job distance

Full captures now write `pulse.snapshot` version 6. This version keeps the v5
shape with two changes:

- Each job has a required `distance_km`: a finite, nonnegative number or `null`.
  It measures the approximate straight-line distance from the configured
  origin to the nearest verified workplace point for the same listing version.
  Municipality-only evidence, missing points and stale bindings give `null`.
- `run_funnel` is `null` when a capture did not follow a source read in a
  refresh. When present, it has the same fields and validation as in v5.

Distance is display data only. It does not enter ranking or model review. Cards
use the captured radius, not current settings, to divide distances into thirds.
The first two bands include their upper endpoints. Longer known distances use
red. Old snapshots and `null` distances show a gray **Distance unknown** tag.

The strict [TypeScript contract](../src/lib/contracts/snapshot.ts) reads v1
through v6. The v1 JSON Schema and the SQLite container do not change. V6 still
includes private inputs. Keep it private and follow the
[viewer-first release order](../docs/operations/phone-snapshots.md#settings-snapshot-compatibility).
