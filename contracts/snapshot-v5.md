# Dashboard snapshot v5

Refresh captures before [v6](snapshot-v6.md) used v5. It keeps the [v4 fields](snapshot-v4.md) and adds
required `run_funnel`. The [Effect Schema](../src/lib/contracts/snapshot.ts)
is strict. It still reads v1 through v4 without adding run counts to them.
The SQLite upload container does not change.

| Field | Meaning |
| --- | --- |
| `run_funnel.nav_events` | Feed changes read in the source sync for the attempt that saved this snapshot. Not unique ads, and not the sum of earlier attempts. |
| `run_funnel.pool` | The saved candidate pool and its outcomes at capture, or `null` if Pulse could not verify the current manifest. A verified empty pool has zero counts. |
| `pool.filters` | `pool` is the number of saved, unexpired ads read for the current manifest. Count each removed ad once: area first, then explicit exclusions, expiry guard, and occupation. `other` includes ads with unusable IDs or ads dropped by the expiry guard. The remainder is `counts.eligible`. |
| `pool.screen` | Eligible ads split into `out` (screened out), `undecided` (no saved decision), and `advanced` (approved for full review). A saved title decision can be reused. `advanced` is not the number of AI requests. |
| `pool.judge` | Advanced ads split into `unfinished` and the five `fits` counts. Each fit uses a saved Judge result for the current candidate. A linked repeat result replaces the first fit when present. |
| `pool.waiting`, `pool.failed` | Separate counts among ads without a title decision or full review. `waiting` means pending. `failed` includes blocked attempts. Other statuses can also be incomplete. |
| `pool.listed_review_ids` | IDs in `jobs` whose displayed result is the result counted in `pool.judge.fits`. Some counted reviews might not appear in `jobs`. Intersect these IDs with the saved `shortlist.job_ids` to count and link recommendations from this pool. |

The NAV event total and the starting ad pool are separate populations. Never
subtract one from the other. Review history also has a separate population:
`counts.reviewed` is the number of saved jobs displayed, split into
`counts.open` and `counts.closed`, and can include results from earlier runs.
The aggregate fields add no new private profile inputs. V5 still needs the
same private-input approval as v4. Follow the
[viewer-first release order](../docs/operations/phone-snapshots.md#settings-snapshot-compatibility).
