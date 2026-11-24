# Fit review boundary

**Implemented:** offline source manifest and supplied-review validation in
`src/lib/server/filter/manifest.ts`. The manifest does not start a model call.
This contract is the bridge between deterministic discovery and personal fit.

## Trust and binding

`build_manifest(source, preferences, profile, profile_id, now=...)` reads an
existing SQLite source read-only in one transaction. It requires explicit
personal interests and locality origin, a nonempty private profile, a caught-up
source check no more than 24 hours old by default, and a bounded candidate pool.
Geography and exclusions use the existing deterministic rules. Unknown/outside
geography is not eligible.

The manifest contains listing identity/version, title, employer, public location
labels, NAV URL, expiry, missing-detail state and approximate geography evidence.
It hashes the private profile instead of copying its text. The private manifest
also carries explicit interest terms and explicitly configured soft-place
preferences/exclusions, plus the hard geography radius; exact origin coordinates
and home postcode are not included. These values and the profile fingerprint,
preference fingerprint, title-rule version, scoring version, candidate fields
and coverage ID are bound by its ID. This is a local integrity binding, **not a
signature or authentication system**. Private manifest/review files must remain
under ignored storage.

A per-review unit is always capped at 120 candidates. The current source also
fails closed above 100,000 stored ads, 10,000 filtered personal matches, 32 MB
of shared coverage metadata, or a 2 MB per-batch manifest. These are absolute
bounds, not permission to silently use a smaller pool. If a bound is exceeded,
preparation blocks and reports no successful coverage. The D19
filters are applied before counting: non-expired inside-radius ads must
survive explicit personal exclusions and match an allowed NAV occupation box.
A preferred term does not admit an ad. A pool over 120 is split into deterministic batches;
all prepared batch manifests share the same source/profile/preferences coverage
binding, and each carries a unique batch-ID fingerprint. `coverage.json` lists
the IDs in each batch and summary counts. Preparation verifies that the union
contains each remaining filtered ID exactly once. At most 100 batches are
written in one preparation; choose a larger batch limit (never above 120) if a
smaller requested limit would exceed that bound.

Each batch manifest contains listing identity/version, title, employer, public
location labels, NAV URL, expiry, missing-detail state and approximate
evidence. No ad descriptions are fetched or persisted. A separate
`text-request.json` lists only the source-bound ID, version and NAV URL for
manual extraction; see [manual pipeline steps](../review/hand-run-review.md#reviewer-readiness).

`review_template(manifest)` deliberately returns an incomplete template.
`validate_review(manifest, review, now=...)` requires schema version 1,
`profile_id`, `manifest_id`, aware `assessed_at`, `complete: true`, and exactly one
assessment per supplied candidate. Each assessment has:

- `id`, `version`, `fit` (`exceptional`, `strong`, `possible`, `poor`, `unknown`);
- a short `reason`, `evidence` and `uncertainties` string arrays;
- `hard_constraints` (`pass`, `fail`, `unknown`) and boolean `ad_text_reviewed`.

Strong/exceptional judgments need source details, reviewed ad text and cited
support. Exceptional judgments cannot carry unresolved fit uncertainties.
The reviewer cannot override authoritative identity, title, employer, geography,
expiry or URL. Rebuild the current batch manifest before validating a stored
review. Candidate versions, profile/preferences/rules and the full filtered
coverage binding must still match. A refreshed source check also requires a
review timestamp after that check.

## Staged review state

The staged core adds `validate_title_screen(...)` with an exact batch schema:
`schema_version`, `profile_id`, `manifest_id`, aware `assessed_at`,
`complete: true`, and one `{id, version, outcome, reason}` row per supplied
candidate. `outcome` is `screened_out` or `advance_to_full_review`; ambiguity
advances. Full review uses the existing `validate_review(...)` contract.

`stage_input_fingerprint(...)` binds the stage schema, canonical instruction
hash, profile/preferences/rules/scorer versions, source fields, and (for full
review) the accepted screening-result ID. It uses a permitted ad-text SHA-256
fingerprint when provided; otherwise source version is the conservative
invalidation key. The profile-local state store commits validated batches
atomically and retains normalized assessment fields, not prompts, raw replies,
transcripts or ads. Run/retry/freshness behavior is documented in
[personal review state](../review/hand-run-review.md). This core persistence is not
a live provider integration or a claim that the coordinator/ranked dashboard is
complete.

## Explicit review completion and later coverage

Preparation, preview and staging do not mean that a person completed review.
See [personal review](../review/hand-run-review.md) for the retained review
workflow. Incomplete, stale, changed, wrong-profile, duplicate or over-cap
reviews are rejected without ledger writes. Exact retries are idempotent; a
conflicting second verdict cannot silently replace an accepted one.

Completed stable NAV IDs live in a private per-profile SQLite `review_db`, not
the confirmed-delivery ledger. Personal-fit ratings and calibration use a
separate feature namespace in that same per-profile database; they do not change
review-completion state or the legacy global relevance store (see
[personal-fit feedback](../review/review-feedback.md)). Records are scoped to the
profile, effective preferences, title rules and scoring version. The ledger
stores IDs, source versions and integrity fingerprints, not descriptions or
assessment text. Later
preparation skips a recorded stable ID even if its source timestamp changes,
while the profile/preferences/rules binding remains the same. That skip is only
a preparation policy: an old assessment does **not** remain valid after its
source version, profile, preferences, rules or current filtered coverage changes.
Revalidation of an unchanged saved review remains valid after recording because
the review ledger does not alter source/profile bindings. Confirmed delivery
remains a separate operator action and storage table; reviewed does not mean
sent, and staged/previewed does not mean reviewed.

The preparation/progress seams expose `eligible_count`, `reviewed_count`,
`remaining_count`, `candidate_count`, `batch_count`, `coverage_id` and batch ID
fingerprints for a read-only UI summary. No dashboard/UI behavior is changed by
this fit-review boundary.

## Limits and next activation

A supplied assessment is an assertion by the accepted reviewing process, not
proof that a model actually read the ad or that salary/terms are verified. Never
feed raw, unconstrained model output directly to delivery. Ads are untrusted
data, not instructions. A remote reviewing session receives whatever profile/ad
text it reads; enabling one needs a separate data, authentication and cost
decision.

The filtered personal pool is not the whole market. Geography still comes first:
non-expired, approximate inside-radius ads remain after explicit personal title,
employer and municipality exclusions. Unknown/outside geography and expired
listings remain ineligible. The second gate keeps an ad only when a stored NAV
occupation box is listed in `allowed_occupation_categories`. A preferred term
does not admit an ad. An allow entry is a level1 label, or `level1 / level2`
when the rest of that level1 box should stay out. Missing occupation boxes do
not admit an ad. Owner title exclusions are not inherited by default; an
explicitly supplied `title_rules_path` applies its rules and is included in the
binding. Explicit personal `preferred_terms` and `allowed_occupation_categories`
are both required. `preferred_terms = []` is a neutral scoring field, not a
second admission option. `allowed_occupation_categories` must be nonempty.
Locality origin and `radius_km` are required. The supplied NAV labels are not a
complete occupational taxonomy. See the
[hand-run guide](../review/hand-run-review.md) and [personal pipeline](personal-pipeline.md)
for operation and current limitations.
