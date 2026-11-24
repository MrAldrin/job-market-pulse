# Review feedback and calibration

Two independent local stores serve different purposes. They do not copy or infer
rows between them, call models or automatically change preferences. The
[feedback event export](../architecture/contracts.md#feedback-events) can read
these origins together without merging their stores.

| Store | Purpose and boundary |
| --- | --- |
| Profile `review_db` | Five-level personal-fit ratings and calibration proposals for the selected profile. Ratings and calibration are postponed; owner/browser acceptance and live model integration are unverified. |
| `data/review.sqlite3` or explicit `--db` | Legacy Good / Bad / Unsure relevance feedback and manual proposals, separate from the feed DB. Explicit profile-scoped rows and legacy unassigned rows remain distinct; the old dashboard routes are removed. See [observations](../pipeline/observations.md). |

## Personal-fit ratings

Ratings retain `very_good`, `good`, `unsure`, `bad` or `very_bad` and provenance. Records exclude titles, ad descriptions, contacts, complete preference snapshots and raw replies. No automatic age pruning is configured.

The feature owns a separate schema namespace in the profile DB. The old
`/ratings` and `/calibration` routes are removed, not the rating and proposal
stores or service APIs. The postponed `calibrate` and `review_feedback` modules
remain. Their presence does not establish a replacement UI or live integration.

## Explicit calibration boundary

Calibration prepares a bounded payload from explicit rating IDs, current profile
narrative and preferences, bound versions and review instructions. Exact UTF-8
file bytes must match fingerprints; do not normalize line endings. Saved
assessments are historical/stale and retain result and source-version identity.
Only normalized values and saved immutable context are used; missing context
stays unavailable. Title/employer are limited to 300 characters each and an
optional snippet to 1,000. It never substitutes current ads or archives full ads.

Preparation calls no model. The payload includes the private narrative, ratings,
reasons, assessments and soft preferences. Inspect it before disclosure: parsed
preferences exclude home postcode and exact origin, but narrative text can still
contain them. Ratings and assessments are untrusted data. Unsure is not a midpoint;
sparse or conflicting evidence can justify no proposal.

A structured result may propose a complete soft-preferences TOML fragment or
exact full-review instruction text. Hard radius, postcode, origin and identity
changes are rejected. Proposals cite selected rating IDs and include rationale,
uncertainty, regression notes, base version and diff. Regression notes are not
a backtest. Unknown fields, unselected evidence, oversized content and stale
bases are rejected. The store retains normalized proposals and a fingerprint,
not raw replies or transcripts.

Proposal events are append-only: `proposed`, `approved`, `rejected`, `applied`
and `stale`. **Approval does not apply a change.** The owner must explicitly
confirm it against current base versions. Recording `applied` requires the current
target hash to match the proposal; it does not edit files. Application marks other
proposals from the same base run stale. A manual confirmation is not authentication.
Apply any file change separately under supervision and the review invalidation rules.

## Retained and postponed workflows

Profile-local rating services can read existing v1 rating history but refuse a rating write to a v1 store rather than migrate it. The dashboard only writes stars and quick reactions, not five-choice ratings or calibration proposals.

The legacy relevance commands and standalone calibration flow are not in the retained CLI. The local export service combines retained feedback sources without applying changes to the profile. Approval is distinct from application. See [feedback events](../architecture/contracts.md#feedback-events).
