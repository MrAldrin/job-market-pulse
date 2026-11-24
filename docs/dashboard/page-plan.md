# Dashboard page plan

This is the first-version design, not a claim that all pages are implemented.
Use the [copy rules](copy-rules.md) for text placement and [UI overview](ui-overview.md) for product intent.
The [snapshot schema](../../contracts/snapshot.schema.json) owns the available data.

## Pages and data

The root server reads saved snapshots through the canonical Snapshot service
and decoder. Components receive typed SvelteKit page data. They never fetch or
parse storage. See the [app boundary](new-dashboard.md#snapshot-boundary).

| Page | Route | Purpose | Snapshot keys |
| --- | --- | --- | --- |
| Home | `#/` | Show the best qualifying jobs. Answer “Is there something for me?” quickly. | `shortlist`, `jobs`, `counts`, `generated_at` |
| Jobs | `#/jobs` | Explore every reviewed job. Filter, search and sort. | `jobs` |
| Job detail | `#/jobs/<id>` | Explain the review and link to the source ad. | One `jobs[]` item |
| Market | `#/market` | Show role-family and term trends, separate from personal fit. | `market`, `reviewed_trend` |
| Salary | `#/salary` | Show stated salary facts for reviewed jobs. | `salary`, `jobs` |
| About | `#/about` | Explain the saved update, coverage and limits. | `generated_at`, `source`, `counts`, `profile` |

Shared status lines use `generated_at` and `counts.reviewed`.
These are snapshot facts, not proof of current source freshness or successful delivery.

## Home

Top to bottom:

1. A result headline, such as **3 strong matches**. Mixed results use a truthful summary, such as **3 matches**.
2. At most one purpose sentence, then the shared status line.
3. One JobCard for each referenced job in `shortlist.job_ids`, resolved against `jobs`.
4. **See all <n> reviewed jobs**, where `<n>` is `counts.reviewed`.
5. One collapsed **About this data** block.

Keep the shortlist's selection order. Exceptional precedes strong; newest first-found dates come first within each group.
Do not reselect jobs or fill a quota in the browser.
Use the saved `status` to exclude closed jobs. Do not describe an uncertain source opening as confirmed open.
Jobs first found within the last seven days carry **New**. Null or future first-found dates are not new.
This is date-based recency, not the old shortlist's browser-local seen tracking.

**Empty state:** if no shortlist jobs resolve, show **No current recommendations** and the reviewed-jobs link.
Use **Nothing new this week** only when seven-day first-found evidence supports it.
An empty shortlist does not establish that no suitable jobs exist.
Retain qualifying older cards when no new matches arrive.

**Phone layout:** use one full-width card per row, with wrapped titles and feedback actions below the job text.

## Jobs

Top to bottom:

1. Heading, one purpose sentence and the shared status line.
2. Search input matching `title` and `employer`, without case sensitivity.
3. Fit-filter chips and a **Show closed** toggle, off by default.
4. Result count and sortable results, using compact JobCard rows where suitable.
5. One collapsed **About this data** block.

Default order: exceptional, strong, possible, unknown, poor; then newest `first_found_at`.
Unknown dates sort last. Use the job ID to break equal-date ties.
This requested page order puts unknown before poor, regardless of the current shared `FIT_ORDER` constant.
Closed jobs retain their saved reviews when the toggle includes them.

**Empty state:** an empty `jobs` array shows **No AI reviews yet**.
Filters with no matches show **No jobs match these filters**, with an action to clear filters.
Do not show **No jobs exist**.

**Phone layout:** convert results into stacked cards, with labels before values and no horizontal page scrolling.

## Job detail

Top to bottom:

1. Title, fit, **New** and **Closed** labels where supported.
2. Employer and locations, keeping missing values explicit.
3. Review reason and a short hard-limit warning when the verdict is fail or unknown.
4. Evidence, uncertainties, hard-limit verdict and whether ad text was reviewed.
5. First-found date, review date and source expiry, each with its own label.
6. Source-ad link and feedback controls when available.
7. One collapsed **About this data** block, with review and source-limit explanations.

Read one item from `jobs`. Use `assessment.reason`, `evidence`, `uncertainties`, `hard_constraints` and `ad_text_reviewed`.
Keep the complete reason available; only card previews are clamped.
A missing job ID shows **Job not found in this snapshot**, with a Jobs link.
Empty evidence or uncertainty lists show **None recorded**, not proof that none exist.

**Phone layout:** keep one column, wrap long text and leave source and feedback actions easy to reach.

## Market

Top to bottom:

1. Heading, one purpose sentence and the shared status line.
2. Retained NAV-sample role-family counts and term trends from `market.monthly` and optional `market.weekly`.
3. A separate reviewed-job trend section from `reviewed_trend`, when its contract supports data.
4. Exact-value tables associated with each available chart.
5. One collapsed **About this data** block with capture, coverage, basis and taxonomy limits.

Never combine the NAV sample with the person's reviewed-job pool.
Keep missing periods as gaps, not zeros. Keep taxonomy versions and coverage labels with their results.

**Empty state:** `market: null` shows **Market trends unavailable**.
An empty period list shows **No market history yet**.
`reviewed_trend: null` shows **Reviewed-job trends unavailable** independently of market data.
Do not hide available market data because another section is unavailable.

**Phone layout:** stack charts vertically and use labelled table cards for exact values.

## Salary

Top to bottom:

1. Heading, one purpose sentence and the shared status line.
2. Available salary statistics, then distributions and per-job facts from `salary`.
3. Job links resolved through `jobs`, without inventing missing salary or identity data.
4. One collapsed **About this data** block for sample, conversions, dates and exclusions.

Use only stated salary facts. Do not infer salary from fit, job title or employer.
Do not implement future salary object fields before the schema defines them.

**Empty state:** `salary: null` shows **Salary facts unavailable**.
A future supported empty collection must show **No stated salary facts**, not zero pay.

**Phone layout:** stack summaries and distributions, then show per-job facts as labelled cards.

## About

Top to bottom:

1. **How it works:** the [job review flow](new-dashboard.md#about), with optional steps based on captured settings.
2. **Fit levels:** one line for each fit and the recommendation rule for the captured search mode.
3. **Last update:** snapshot and source check times, source name and captured search mode. The **About this data** block preserves page-wide caveats.

**Empty state:** null `source.checked_at` reads **Source check unknown**.
Do not infer that a pipeline ran successfully or that delivery occurred.
A missing or invalid snapshot uses the shell's snapshot error state, not a fabricated About record.

**Phone layout:** show the steps in one column. Stack the update fields above the caveats.

## Feedback

Controls appear on Home cards and Job detail, not in the first-version Jobs table.
The [UI overview](ui-overview.md#phone-shortlist-digest-page) defines their meaning:

- A star saves a job for return visits. It does not keep an expired job active.
- Thumbs judge the recommendation, not the accuracy of its AI assessment.
- Selecting the active thumb clears it. Selecting the other thumb replaces it.
- A star and a reaction can coexist. A downvote does not hide a job.
- Show optimistic changes, then the server-confirmed state. On failure, restore the last confirmed state and show a retryable error.
- If the feedback API is unavailable, show no feedback controls and no error banner.

Use the [feedback API contract](../architecture/contracts.md#shortlist-feedback-api).
Feedback state is separate from snapshot data. These controls never edit the profile or start model work.

## Current contract gaps

- Snapshot v1 now supports reviewed-job trends and salary objects. Either section can still be null. See the [snapshot contract](../architecture/contracts.md#snapshot-v1-contract).
- `jobs[].expires_at` is source expiry, not the application deadline. Never label it **Apply by**.
- Snapshot v1 has no application-deadline field, freshness limit, caught-up flag or complete run-status record.
- Do not infer those facts from `generated_at`, source check time, mode or counts.
- Keep policy explanations distinct from per-snapshot facts. Leave unsupported facts unknown until the exporter and contract supply them.

These gaps do not prevent the documented empty states. They do prevent claims of complete operational status.

## Not in the first version

The replacement dashboard does not expose five-level rating, calibration or evidence-pool pages.
No automatic profile correction, refresh button, scheduling or delivery control is introduced here.
Final visual direction is separate from page behavior; use neutral shadcn defaults until that direction is chosen.
