# UI overview

This page defines the purpose and intended behavior of the two viewing experiences. The [product goal](../product-goal.md) owns the
broader direction. The technical guides explain how to run the dashboard.

For new-dashboard text placement, use the [copy rules](copy-rules.md).
These rules preserve existing caveats without putting them before results.
The [page plan](page-plan.md) defines routes, data, empty states and phone layouts.

## New dashboard (implemented, local)

The [local Svelte dashboard](new-dashboard.md) reads the snapshot contract only.
Home shows the saved shortlist. Jobs searches and filters saved reviews.
Job detail shows the saved assessment, evidence and source link. About shows
saved status and limits. Market and Salary show charts when the snapshot
contains the necessary data. Home and Job detail show stars and thumbs when
the separate feedback API is available; Jobs has a Saved filter.

The [page plan](page-plan.md) is intended design, not a completed-page checklist.
The [copy rules](copy-rules.md) govern text placement. Neutral shadcn defaults
remain in use. No hosted release or owner desktop/phone acceptance is established.
The hosted replacement serves the same Svelte app behind login after cut-over. The old Python
dashboard and HTML phone-page routes are removed.

## Full dashboard

**Agreed goal:** explore reviewed jobs and understand the monitored market.
Show broader possibilities, saved review reasons, evidence and market views.
The owner uses this view to see more. It is not a list they must regularly manage.

**Current boundary:** Svelte Jobs and Job detail show saved reviewed jobs.
Snapshot JSON also retains titles-only market aggregates, reviewed-job counts
by first-seen date and funnel-only salary facts. The old Python personal-fit,
evidence, market, salary, calibration and local reference pages are removed.
There is no captured dashboard page bundle. See [implemented dashboard views](new-dashboard.md#implemented-status),
[data boundaries](review-ui.md), [Job shortlist](phone-view.md) and
[snapshot operations](../operations/phone-snapshots.md).

**Open:** future layout refinements and mockups. No redesign is selected.

## Phone shortlist (digest page)

**Agreed goal:** a small, low-effort view of the best current opportunities,
with a clear link to the full dashboard for everything else.

- While just looking, show **exceptional** saved matches. Actively looking also shows **strong** matches.
  Keep possible matches in the full dashboard. Show exceptional before strong;
  within each category, show newest first-found dates first (not a hidden fit score).
- Keep qualifying recommendations across refreshes, even when nothing new is
  found. Remove closed or expired jobs using source evidence, without repeating
  AI suitability reviews.
- Show when each recommendation was first found. Make unseen additions stand
  out with a border and a “New” label; keep the highlight until seen, then for
  three days. The fit label and the new-job label mean different things.
- Always show a real page, including a clear empty state when there are no matches.

**Implemented:** Svelte Home shows the saved shortlist, fit labels, first-found
dates and date-based New labels. Jobs and Job detail provide broader saved-data
views. Home and Job detail have stars and thumbs when the feedback API is
available. A star saves a job to revisit; a thumb judges the recommendation, not
its AI assessment. Controls use a separate server-side store. These are
implemented and offline-tested, not verified phone acceptance. The former HTML
phone pages and browser-local seen tracking are not the current viewer.

Selection and ordering follow the rules above. First found is the earliest saved
full-review date; closed/expired removal takes effect on snapshot capture.
A downvote does not hide a job. A star does not keep an expired job active.
These controls do not change profiles or the separate five-choice ratings.
See [capture details](../operations/phone-snapshots.md).

**Later:** an explicit “I am looking” switch should broaden the recommendations.
This page's selection is distinct from the product's stricter passive
[notification policy](../product-goal.md#two-levels-of-attention).

**Open:** whether a further top-card limit is useful after narrowing selection.
Manual dismissal and cross-device seen tracking are deferred. Stars and quick
reactions have offline implementation and tests; live and phone/browser acceptance
remain unverified. See [local feedback](new-dashboard.md#local-feedback).
