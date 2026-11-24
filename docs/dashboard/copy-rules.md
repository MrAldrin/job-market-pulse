# Dashboard copy rules

These are rules for the new dashboard. The inventory below records copy from
the removed Python pages as input to the new design, not current routes or
implemented controls. Retained rating/calibration stores have no replacement UI.
The [page plan](page-plan.md) defines page content. Use the [writing style](../writing-style.md) for general prose.

## Before the first result

Before the first job or chart, show at most:

- One heading.
- One sentence of purpose.
- One status line: **Updated <relative time> · <n> jobs reviewed**.

The status line becomes a warning only when data exceeds the profile's freshness limit.
Do not guess a limit when the snapshot does not supply one.
An unknown update time reads **Updated time unknown · <n> jobs reviewed**, without a stale warning.
An unavailable-data message replaces the missing result. Do not add a second introductory banner.
Controls, result labels and chart values are not introductory prose.

## Caveats and job facts

- Put page-wide caveats in one collapsed block named **About this data**, at the page end.
- Keep every distinct caveat. Link to About for the full run and coverage record.
- Keep a job-specific caveat on its job as a short label. Put its explanation in Job detail.
- Keep missing data unknown. Never replace a missing count with zero.
- Keep unavailable results visible as empty states, not warnings about old data.
- Do not put private profile text or preference values in public examples.

## Words

Say **jobs**, not **listings** or **funnel jobs**. Say **AI review**, not **saved full AI review**.
Use sentence case. Each sentence has at most 20 words.
Do not imply that an AI review proves a fact or that unknown status means open.
Keep interface field names unchanged when explaining a contract.

## Current text → new place

The “Current text” columns quote the former pages. Proposed placements do not
establish current implementation; see the [dashboard guide](new-dashboard.md).

This is the baseline inventory from the Python renderers, inspected offline.
The current-text column predates the Personal fit copy change.
That inventory work opened no browser, private snapshot or live source.
It changed documentation only.

The current-text column gives the first eight words, or the whole text when shorter.
Braces stand for runtime values, not copied private data.
A dynamic paragraph has one row for its expression; its values stay with that expression.
**Status line** includes a result count or empty-state message in the relevant result section.
**Job label** includes ordinary job fields and actions, not only warnings.
No removal below loses a fact: each duplicate row names its retained row.

### Shared shell and About

All Python paths in this inventory are under `src/pulse/dashboard/`, except `phone_shortlist.py` under `src/pulse/select/`.

| Page | Current text (first 8 words) | Keep as | New wording |
| --- | --- | --- | --- |
| All | Offline snapshot — may be stale. No source | About this data | This page reads saved data. It does not refresh the source. |
| Fit | Best matches from your saved AI reviews. | About this data | These matches come from saved AI reviews. |
| Fit, captured | Saved personal-fit results, if available in this digest. | remove because duplicate | Retain the saved-review fact in the preceding row. |
| Evidence | Nearby keyword-evidence jobs that passed your funnel; rate | About this data | These reviewed jobs have keyword evidence and pass the location filter. Rating is optional. |
| Evidence, captured | Funnel jobs with keyword evidence in the eligible | remove because duplicate | Retain the pool definition in the preceding row. |
| Market | NAV market aggregates, with your reviewed-job statistics in | About this data | NAV sample aggregates and reviewed-job statistics are separate. |
| Market, captured | Counts, trends and salary facts for your reviewed | About this data | Reviewed-job counts, trends and salary facts cover reviewed jobs only. |
| About | Snapshot age, coverage and location rules. | About this data | This page explains saved-data age, coverage and location rules. |
| About | Last successful check: {time}. Snapshot age at page | status line | Updated {relative time} · {n} jobs reviewed. |
| About | Feed pages caught up at that check: {yes/no} | About this data | Feed pages were {caught up/not caught up} at the saved check. Each ad needs a separate detail-freshness check. |
| About | Snapshot age unknown: no successful check time is | status line | Updated time unknown · {n} jobs reviewed. |
| About | Snapshot age unknown: the saved check time is | About this data | The saved check time is invalid or in the future. Its age is unknown. |
| About | Snapshot age unknown: the saved check time has | About this data | The saved check time has no timezone. Its age is unknown. |
| About | Coverage starts at change-feed time {start}; it is | About this data | Collection starts at {time}. This NAV changes sample is not a complete job inventory. |
| About | Coverage is a sample of collected NAV changes, | About this data | This NAV changes sample is not a complete job inventory. |
| About | Hard {radius} km cutoff from the {centre}. Title | About this data | The configured radius is a hard limit. Title relevance cannot override it. Unknown locations are not eligible. |
| About | An official address point, or a whole listed | About this data | An official address point or whole municipality must be inside the radius. Distances are approximate, not commute distances. |
| About | Municipality labels count only when the whole municipality | About this data | A municipality counts only when its whole boundary is inside the radius. An empty pool does not prove no local jobs exist. |
| About | Evidence counts cover only funnel jobs: they passed | About this data | Counts require the location filter, title screen and AI review. Closed and expired jobs are excluded. Explicit exclusions apply before review-state and observation filters. These are not national vacancy totals. |
| About | Within {radius} km with keyword evidence and a | About this data | Eligible jobs have keyword evidence, an AI review and an accepted location. |
| About | Location unknown with keyword evidence and a saved | About this data | Unknown-location jobs have keyword evidence and an AI review, but are not eligible. |
| About | No interest signals, inside or unknown location: inspection | About this data | Background jobs have no interest signals. They are for inspection only. |
| About | Outside {radius} km: inspection only. | About this data | Jobs outside the radius are for inspection only. |
| About | Local help: Review UI guide · Feedback guide. | About this data | Read the Review UI guide or Feedback guide. |

### Personal fit


| Page | Current text (first 8 words) | Keep as | New wording |
| --- | --- | --- | --- |
| Fit | Personal-fit results are unavailable because this digest has | status line | No profile was selected. Personal results are unavailable. |
| Fit | Review store could not be read. No jobs | status line | Reviews could not be read. No jobs are shown. |
| Fit | No profile is selected, so no reviewed jobs | remove because duplicate | Retain the missing-profile message in the first Fit row. |
| Fit | Current personal results are unavailable. {error} | status line | Personal results are unavailable. {safe error} |
| Fit | Open retained personal rating history | About this data | Personal rating history is retained; its UI is postponed. |
| Fit | No saved fit reviews are available in this | status line | No AI reviews in this snapshot. |
| Fit | No saved fit reviews to show yet. Saved | status line | No AI reviews yet. Saved reviews fill this view. Rating is optional. |
| Fit | Explicit profile {id}. Saved AI fit, ordered exceptional | About this data | The selected profile is {id}. Order is exceptional, strong, possible, then unknown. Poor fits are hidden here. This view starts no reviews, applications or employer contact. |
| Fit | Source check: {time}. Your reviewed jobs: {n} with | status line | Updated {relative time} · {n} jobs reviewed. |
| Fit | Saved results remain visible across old source checks | About this data | Reviews remain visible across refreshes. Unknown status does not mean open. Closed history separates application deadlines, source expiry and removals. AI assessments are not independently verified facts. |
| Fit job | Warning: this saved review failed hard constraints. | job label | Hard limits failed. Detail: the saved review reports a failed hard limit. |
| Fit job | Warning: hard constraints are not confirmed; the saved | job label | Hard limits unknown. Detail: the review did not confirm all hard limits. |
| Fit job | {employer} · {locations} | job label | {employer} · {locations}; keep unknown fields explicit. |
| Fit job | Reviewed on an earlier refresh; current opening not | job label | Earlier review; opening unconfirmed. Detail: reviewed on an earlier refresh. |
| Fit job | Current status unknown; not confirmed open | job label | Opening unconfirmed. Detail: current source status is unknown. |
| Fit job | Saved source listing; current opening not confirmed | job label | Opening unconfirmed. Detail: only saved source evidence is available. |
| Fit job | Application deadline passed — closed history, not a | job label | Deadline passed. Detail: closed history, not a current opening. |
| Fit job | NAV listing expiry passed — closed history, not | job label | Source expired. Detail: source expiry is not an application deadline. |
| Fit job | Source confirmed gone or expired — closed history | job label | Source closed. Detail: the source confirmed removal or expiry. |
| Fit job | {lifecycle label}. {provenance}. | job label | Keep the lifecycle label on the job. Keep provenance in Job detail. |
| Fit job | Application due (latest saved source): {due}. NAV listing | job label | Apply by {due/unknown}. Detail: source expiry is separate from the application deadline. |
| Fit job | {assessment reason / No saved reason.} | job label | Keep the review reason. Show “No review reason” when absent. |
| Fit job | Hard-constraint verdict: {verdict} | job label | Hard limits: {verdict}. Keep the full verdict in Job detail. |
| Fit job | Ad text reviewed: {yes/no} | job label | Ad text reviewed: {yes/no}. |
| Fit job | Evidence | job label | Evidence; keep every recorded evidence item in Job detail. |
| Fit job | Uncertainties | job label | Uncertainties; keep every recorded uncertainty in Job detail. |
| Fit | No saved exceptional, strong or possible fits are | status line | No matches in this view. This does not mean no suitable jobs exist. |
| Fit | Showing {shown} of {total} current completed reviews. | status line | Showing {shown} of {total} reviewed jobs. |
| Fit | {n} saved reviews with a poor AI fit | About this data | Poor fits are hidden in this intended view. Do not imply a removed Evidence route is available. |
| Fit | The review finished but returned an unknown fit, | About this data | Some reviews could not judge fit, often because ad details were missing. Check these jobs yourself. |
| Fit | Rate fit reviews and inspect personal history · | About this data | Rating and calibration services remain; their old routes are removed. |

### Evidence jobs


| Page | Current text (first 8 words) | Keep as | New wording |
| --- | --- | --- | --- |
| Evidence | Up to three nearby funnel jobs (location filter, | About this data | Up to three picks use deterministic keyword evidence inside the radius. They passed the location filter, title screen and AI review. This broad view does not apply the personal occupation gate. It is not a personal-fit verdict. |
| Evidence, captured | Up to three nearby funnel jobs with keyword | remove because duplicate | Retain the selection limits in the preceding row. |
| Evidence | Opt-in inspection pool, not part of the default | About this data | This inspection pool is not the eligible pool. Unknown locations do not prove inclusion inside the radius. |
| Evidence | No eligible evidence-bearing jobs in this snapshot. | status line | No eligible jobs in this snapshot. |
| Evidence | No jobs in this view. | status line | No jobs in this view. |
| Evidence picks | No evidence-bearing jobs within {radius} km in this | status line | No eligible picks in this snapshot. |
| Evidence | Unknown locations do not establish that a job | About this data | Unknown locations cannot prove inclusion. An empty eligible pool does not prove no local jobs exist. |
| Evidence | No evidence-bearing jobs have official address points estimated | About this data | No jobs in this view have accepted location evidence. Whole-municipality evidence also needs its full boundary inside the radius. Check unknown locations or change the review-state filter. Distances are approximate. |
| Evidence | No explicit observation capture has been recorded. | About this data | No observation capture is recorded. |
| Evidence | Latest explicit capture: {time}. Observation means seen, not | About this data | Latest observation capture: {time}. Observation means seen, not reviewed. A different source version is labelled changed. |
| Evidence | Snapshot scope: all nonexcluded funnel jobs with keyword | About this data | The snapshot includes all nonexcluded, eligible reviewed jobs with keyword evidence. Review-state, observation-state and page limits do not apply. This is a NAV changes sample, not a complete job inventory. |
| Evidence | Location-pool counts: {counts}. | About this data | Location-pool counts: {counts}. |
| Evidence | Latest-capture counts: {counts}. | About this data | Latest-capture counts: {counts}. |
| Evidence | {n} eligible evidence-bearing jobs in this snapshot. | status line | {n} jobs in this snapshot. |
| Evidence | Location pool | status line | Location pool; retain the filter controls. |
| Evidence | Selected pool: {pool}. | status line | Pool: {pool}. |
| Evidence | Review state | status line | Review state; retain the filter controls. |
| Evidence | Observation in latest capture | status line | Observation; retain the filter controls. |
| Evidence | {n} jobs in this view. Page {page}. | status line | {n} jobs · Page {page}. |
| Evidence | {n} hidden by {rule} {context} | About this data | {n} jobs hidden by {rule}. Keep hidden-job reasons accessible when this view is implemented. |
| Evidence job | {employer} — {location} | job label | {employer} · {location}. |
| Evidence job | {deterministic pick reason} | job label | Keep the evidence reason. Do not call it personal fit. |
| Evidence job | Observation in latest capture: {state}. Keyword evidence, not | job label | {observation state}. Detail: keyword evidence is not suitability. |
| Evidence job | Unknown: {assessment unknowns} | job label | Review uncertainties. Keep all unknowns in Job detail. |
| Evidence job | Status: {geography status}. {geography summary} | job label | {geography status}. Keep point accuracy, radius and municipality evidence in Job detail. |
| Evidence job | Details unavailable; summary fields only. | job label | Ad details missing. Detail: only summary fields were available. |
| Evidence job | Earlier relevance judgment (retired scale): {verdict} {time} | job label | Earlier relevance rating: {verdict}. Keep its date and reason when rating history is displayed. |
| Evidence job | Original NAV listing | job label | Open original job. |
| Evidence job | Saved personal rating: {rating} {time} | job label | Saved rating: {rating}. Keep its date when rating history is displayed. |
| Evidence job | Your rating: {rating} {time} | remove because duplicate | Retain the saved rating and date in the preceding row. |
| Evidence job | No saved personal rating. / Not rated yet. | job label | Not rated. |

### Market and salary


| Page | Current text (first 8 words) | Keep as | New wording |
| --- | --- | --- | --- |
| Market | Recorded titles-only aggregates from the monitored NAV sample. | About this data | Counts use retained titles from the monitored NAV sample. They are not personal fit, radius counts or national totals. This page does not refresh them. |
| Market | Latest retained capture: {date}. Capture dates and coverage | status line | Updated {relative time} · {n} jobs reviewed. Capture and coverage details stay in About this data. |
| Market | A snapshot not marked sampled is not proof | About this data | A snapshot without a sampled label does not prove full-market coverage. |
| Market | Excluded incompatible basis snapshots: {bases}. They are not | About this data | Incompatible snapshot bases are excluded: {bases}. They are not mixed with titles-only history. |
| Market | No monthly titles-only snapshots are retained; the weekly | status line | No monthly history. Weekly history is shown separately. |
| Market | No comparable weekly snapshots are retained. | status line | No comparable weekly history. |
| Market | Counts use retained titles-only market aggregates. Missing periods | About this data | Missing periods are gaps, not zero. Taxonomy changes break lines. Partial, unverified and ended calendar periods remain distinct. An ended period does not prove complete collection. |
| Market | Within each month, count and share come from | About this data | Reviewed-job counts and shares use the same first-seen period and titles-only basis. Share is tech/data jobs divided by all jobs. Lines break across taxonomy versions. |
| Market | Each point is a retained titles-only aggregate from | About this data | Each point is a retained NAV sample aggregate. Missing periods and taxonomy changes break lines. Share is tech/data jobs divided by all jobs. The sample is not the national market. |
| Market | Bars show recorded family counts; check the taxonomy | About this data | Compare family counts only within the same taxonomy version. |
| Market | Stacked family chart unavailable: retained snapshots use different | status line | Family classifications differ. Use the table, which keeps taxonomy versions separate. |
| Market | Your reviewed jobs only: NAV ads that passed | About this data | Reviewed jobs passed the radius filter, title screen and AI review. Counts use first-seen month or week. These are not national counts or personal recommendations. Tech/data excludes Other. Monthly figures use titles only. |
| Market | Trends describe your reviewed jobs by first-seen month | About this data | Reviewed-job trends use first-seen dates. They are context, not recommendations. Family charts show known categories only. |
| Market | Hover, focus, or tap a chart mark to | About this data | Hover, focus or tap a chart mark for its value. Expand the chart or open its values table. |
| Market | No AI or data terms counted in {period} | status line | No AI or data terms counted for {period} in {scope}. |
| Market | No NAV ads are stored yet, so there | status line | No saved jobs. Reviewed-job figures are unavailable. |
| Market | Your reviewed jobs could not be counted: the | status line | Reviewed-job counts are unavailable. The source table could not be read. |
| Market | No reviewed job has a first-seen date yet, | status line | No first-seen dates. Monthly figures and trends are unavailable. |
| Market | Market trends are unavailable: no market snapshot store | status line | Market trends unavailable: no store selected. |
| Market | Market trends are unavailable: the selected market snapshot | status line | Market trends unavailable: the selected store is missing. |
| Market | Market trends are unavailable: the selected aggregate store | status line | Market trends unavailable: the store could not be read. |
| Market | Market trends are unavailable: the retained aggregate counts | status line | Market trends unavailable: counts are incomplete or inconsistent. |
| Market | Market trends are unavailable: no retained monthly or | status line | Market trends unavailable: no retained monthly or weekly periods. |
| Market | No suitable titles-only market snapshots are available for | status line | No compatible titles-only snapshots. Other stored bases are not mixed into these charts. |
| Market | Market view is turned off for this installation | status line | Market taxonomy is disabled for this installation. |
| Market values | {KPI label} / {value} / {comparison context} | status line | Keep numeric values and their period, partial-month and comparison labels with each result. |
| Salary | Covers your reviewed jobs only: ads outside the | About this data | Salary facts cover reviewed jobs only. Details read since 2026-10-28 can have stored facts. Earlier jobs and unstated pay are excluded. Counts are not a market share. |
| Salary | No salary facts for your reviewed jobs yet. | status line | No salary facts for reviewed jobs yet. |
| Salary | Salary facts could not be read. | status line | Salary facts could not be read. |
| Salary | Pay stated in NAV ad text. Each ad | About this data | Salary is stated in ad text. Each job counts once, by latest stored NAV version month in UTC. Brackets use midpoints. |
| Salary | Yearly equivalent: a year is used as stated, | About this data | Annual pay is unchanged. Monthly pay is multiplied by 12. Hourly pay is multiplied by 1,950, assuming 37.5 hours over 52 weeks. |
| Salary | Amounts without a stated or labelled period are | About this data | Amounts with no stated or labelled period enter counts only. Monthly medians exclude annual amounts outside the plausible range. |
| Salary | Left out: {n} salary rows of your reviewed | About this data | {n} reviewed-job salary rows have no usable date and are excluded. |
| Salary | Numeric brackets: {n}. Not shown: fewer than {minimum} | status line | {n} numeric brackets. Statistics need at least {minimum}. |
| Salary | Not in these statistics: {n} with SKO, lønnstrinn | About this data | Statistics exclude vague pay, SKO, lønnstrinn, maximum-only amounts, unusable periods and amounts outside the plausible range. Keep each exclusion count and the range. |
| Salary | No numeric brackets to plot. | status line | No numeric salary brackets to plot. |
| Salary | Each bar runs from the lowest to the | About this data | Bars show each family's annual range. Boxes show the middle half; lines show the median. Both need five numeric brackets. |
| Salary | {family spread text with small-sample counts} | status line | Keep family counts, ranges and small-sample explanations next to the result. |
| Salary | Select a column heading to sort when scripts | About this data | Select a column heading to sort. Sorting needs scripts. |
| Salary | NAV ad last changed is detail_changed, the NAV | About this data | The date is the stored NAV version time, not extraction time. The store has no extraction timestamp. |
| Salary | Amounts outside the plausible yearly range stay in | About this data | Out-of-range amounts remain labelled in the table. They are excluded from statistics, spread, medians and highest/lowest lists. |
| Salary | Closed ads keep their salary fact. Their title, | About this data | Closed jobs keep salary facts, but not titles, employers or role families. Their source links may no longer work. |

### Phone shortlist

Source: `phone_shortlist.py::render_shortlist`. New-dashboard recency follows the page plan, not browser-local seen tracking.

| Page | Current text (first 8 words) | Keep as | New wording |
| --- | --- | --- | --- |
| Shortlist | Saved matches | About this data | The shortlist keeps saved matches selected by the captured search mode. |
| Shortlist | Updated {date} | status line | Updated {relative time} · {n} jobs reviewed. |
| Shortlist | Good matches stay here across refreshes, until closed | About this data | Matches stay across refreshes until source evidence closes or expires them. |
| Shortlist | Recommendations will appear here when saved reviews find | status line | No current recommendations. New matches appear after AI review. A refresh without matches does not clear saved recommendations. |
| Shortlist | New borders stay until you see a job, | About this data | The old shortlist highlights unseen jobs, then keeps the highlight for three days. Seen state is browser-local. Another browser can show them as new. |
| Shortlist | Enable JavaScript to remember which jobs you have | About this data | Browser-local seen tracking needs JavaScript. |
| Shortlist job | {employer} | job label | {employer}. |
| Shortlist job | {review reason} | job label | Keep the AI review reason. |
| Shortlist job | {fit} match · First found: {date/Not recorded} | job label | {fit} · First found {date/unknown}. |
| Shortlist job | Deadline: {date} | job label | Apply by {application deadline/unknown}. Detail: never label source expiry as an application deadline. |
| Shortlist job | Source status unconfirmed | job label | Opening unconfirmed. |

## Application limit

This inventory preserves old-page meanings; it does not authorize a renderer rewrite.
Some current facts are not yet exported in snapshot JSON. Do not invent them in the new dashboard.
The [page plan](page-plan.md#current-contract-gaps) identifies those gaps. Existing pages remain available until the owner retires them.
