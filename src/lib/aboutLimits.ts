/** Caveat inventory from docs/dashboard/copy-rules.md. Coverage is tested. */
export const ABOUT_LIMITS = [
  {
    page: 'All',
    source: 'Offline snapshot — may be stale. No source',
    text: 'This page reads saved data. It does not refresh the source.',
  },
  {
    page: 'Fit',
    source: 'Best matches from your saved AI reviews.',
    text: 'These matches come from saved AI reviews.',
  },
  {
    page: 'Evidence',
    source: 'Nearby keyword-evidence jobs that passed your funnel; rate',
    text: 'These reviewed jobs have keyword evidence and pass the location filter. Rating is optional.',
  },
  {
    page: 'Market',
    source: 'NAV market aggregates, with your reviewed-job statistics in',
    text: 'NAV sample aggregates and reviewed-job statistics are separate.',
  },
  {
    page: 'Market, captured',
    source: 'Counts, trends and salary facts for your reviewed',
    text: 'Reviewed-job counts, trends and salary facts cover reviewed jobs only.',
  },
  {
    page: 'About',
    source: 'Snapshot age, coverage and location rules.',
    text: 'This page explains saved-data age, coverage and location rules.',
  },
  {
    page: 'About',
    source: 'Feed pages caught up at that check: {yes/no}',
    text: 'Feed-page catch-up is separate from ad-detail freshness. Each ad needs a detail-freshness check. This snapshot has no catch-up flag.',
  },
  {
    page: 'About',
    source: 'Snapshot age unknown: the saved check time is',
    text: 'If a saved check time is invalid or in the future, its age is unknown.',
  },
  {
    page: 'About',
    source: 'Snapshot age unknown: the saved check time has',
    text: 'If a saved check time has no timezone, its age is unknown.',
  },
  {
    page: 'About',
    source: 'Coverage starts at change-feed time {start}; it is',
    text: 'Collection start time is not exported here. The NAV changes sample is not a complete job inventory.',
  },
  {
    page: 'About',
    source: 'Coverage is a sample of collected NAV changes,',
    text: 'This NAV changes sample is not a complete job inventory.',
  },
  {
    page: 'About',
    source: 'Hard {radius} km cutoff from the {centre}. Title',
    text: 'The configured radius is a hard limit. Title relevance cannot override it. Unknown locations are not eligible.',
  },
  {
    page: 'About',
    source: 'An official address point, or a whole listed',
    text: 'An official address point or whole municipality must be inside the radius. Distances are approximate, not commute distances.',
  },
  {
    page: 'About',
    source: 'Municipality labels count only when the whole municipality',
    text: 'A municipality counts only when its whole boundary is inside the radius. An empty pool does not prove no local jobs exist.',
  },
  {
    page: 'About',
    source: 'Evidence counts cover only funnel jobs: they passed',
    text: 'Legacy evidence counts require the location filter, title screen and AI review. Closed and expired jobs are excluded. Explicit exclusions apply before review-state and observation filters. These are not national vacancy totals.',
  },
  {
    page: 'About',
    source: 'Within {radius} km with keyword evidence and a',
    text: 'Eligible evidence-pool jobs have keyword evidence, an AI review and an accepted location.',
  },
  {
    page: 'About',
    source: 'Location unknown with keyword evidence and a saved',
    text: 'Unknown-location jobs have keyword evidence and an AI review, but are not eligible.',
  },
  {
    page: 'About',
    source: 'No interest signals, inside or unknown location: inspection',
    text: 'Background jobs have no interest signals. They are for inspection only.',
  },
  {
    page: 'About',
    source: 'Outside {radius} km: inspection only.',
    text: 'Jobs outside the radius are for inspection only.',
  },
  {
    page: 'About',
    source: 'Local help: Review UI guide · Feedback guide.',
    text: 'Read the Review UI guide or Feedback guide.',
  },
  {
    page: 'Fit',
    source: 'Open retained personal rating history',
    text: 'Open personal rating history in the old dashboard.',
  },
  {
    page: 'Fit',
    source: 'Explicit profile {id}. Saved AI fit, ordered exceptional',
    text: 'The old fit view uses an explicit profile. Order is exceptional, strong, possible, then unknown. Poor fits are hidden there. This dashboard starts no reviews, applications or employer contact.',
  },
  {
    page: 'Fit',
    source: 'Saved results remain visible across old source checks',
    text: 'Reviews remain visible across refreshes. Unknown status does not mean open. Closed history separates application deadlines, source expiry and removals. AI assessments are not independently verified facts.',
  },
  {
    page: 'Fit',
    source: '{n} saved reviews with a poor AI fit',
    text: 'Poor fits are hidden in the old fit view. Inspect them in its Evidence jobs view.',
  },
  {
    page: 'Fit',
    source: 'The review finished but returned an unknown fit,',
    text: 'Some reviews could not judge fit, often because ad details were missing. Check these jobs yourself.',
  },
  {
    page: 'Fit',
    source: 'Rate fit reviews and inspect personal history ·',
    text: 'Ratings, calibration and review-state help remain in the old dashboard.',
  },
  {
    page: 'Evidence',
    source: 'Up to three nearby funnel jobs (location filter,',
    text: 'Old evidence picks show up to three jobs using deterministic keyword evidence inside the radius. They passed location, title screening and AI review. This broad view does not apply the personal occupation gate. It is not a personal-fit verdict.',
  },
  {
    page: 'Evidence',
    source: 'Opt-in inspection pool, not part of the default',
    text: 'Old inspection pools are separate from the eligible pool. Unknown locations do not prove inclusion inside the radius.',
  },
  {
    page: 'Evidence',
    source: 'Unknown locations do not establish that a job',
    text: 'Unknown locations cannot prove inclusion. An empty eligible pool does not prove no local jobs exist.',
  },
  {
    page: 'Evidence',
    source: 'No evidence-bearing jobs have official address points estimated',
    text: 'An empty eligible view has no jobs with accepted location evidence. Whole-municipality evidence needs its full boundary inside the radius. In the old dashboard, check unknown locations or the review-state filter. Distances are approximate.',
  },
  {
    page: 'Evidence',
    source: 'No explicit observation capture has been recorded.',
    text: 'If no observation capture is recorded, observation status is unknown. This snapshot does not export observation capture state.',
  },
  {
    page: 'Evidence',
    source: 'Latest explicit capture: {time}. Observation means seen, not',
    text: 'Observation means seen, not reviewed. A different source version is labelled changed. Observation capture time is not exported here.',
  },
  {
    page: 'Evidence',
    source: 'Snapshot scope: all nonexcluded funnel jobs with keyword',
    text: 'Old evidence snapshots include all nonexcluded, eligible reviewed jobs with keyword evidence. Review-state, observation-state and page limits do not apply. This is a NAV changes sample, not a complete inventory.',
  },
  {
    page: 'Evidence',
    source: 'Location-pool counts: {counts}.',
    text: 'Location-pool counts describe the old evidence pools. They are not exported here.',
  },
  {
    page: 'Evidence',
    source: 'Latest-capture counts: {counts}.',
    text: 'Latest-observation counts describe the old evidence captures. They are not exported here.',
  },
  {
    page: 'Evidence',
    source: '{n} hidden by {rule} {context}',
    text: 'The old evidence view reports hidden-job counts, exclusion rules and individual reasons. Those details are not exported here.',
  },
  {
    page: 'Evidence job',
    source: 'Rating needs an explicitly selected profile: start the',
    text: 'Old-dashboard ratings need an explicit profile. Start that launcher with --profile.',
  },
  {
    page: 'Market',
    source: 'Recorded titles-only aggregates from the monitored NAV sample.',
    text: 'Counts use retained titles from the monitored NAV sample. They are not personal fit, radius counts or national totals. This page does not refresh them.',
  },
  {
    page: 'Market',
    source: 'A snapshot not marked sampled is not proof',
    text: 'A snapshot without a sampled label does not prove full-market coverage.',
  },
  {
    page: 'Market',
    source: 'Excluded incompatible basis snapshots: {bases}. They are not',
    text: 'Incompatible snapshot bases are excluded from titles-only history. Their names are not exported here.',
  },
  {
    page: 'Market',
    source:
      'Counts use retained titles-only market aggregates. Missing periods',
    text: 'Missing periods are gaps, not zero. Taxonomy changes break lines. Partial, unverified and ended calendar periods remain distinct. An ended period does not prove complete collection.',
  },
  {
    page: 'Market',
    source: 'Within each month, count and share come from',
    text: 'Reviewed-job counts and shares use the same first-seen period and titles-only basis. Share is tech/data jobs divided by all jobs. Lines break across taxonomy versions.',
  },
  {
    page: 'Market',
    source: 'Each point is a retained titles-only aggregate from',
    text: 'Each point is a retained NAV sample aggregate. Missing periods and taxonomy changes break lines. Share is tech/data jobs divided by all jobs. The sample is not the national market.',
  },
  {
    page: 'Market',
    source: 'Bars show recorded family counts; check the taxonomy',
    text: 'Compare family counts only within the same taxonomy version.',
  },
  {
    page: 'Market',
    source: 'Your reviewed jobs only: NAV ads that passed',
    text: 'Legacy reviewed-job statistics cover jobs that passed radius filtering, title screening and AI review. Counts use first-seen month or week. They are not national counts or personal recommendations. Tech/data excludes Other. Monthly figures use titles only.',
  },
  {
    page: 'Market',
    source: 'Trends describe your reviewed jobs by first-seen month',
    text: 'Reviewed-job trends use first-seen dates. They are context, not recommendations. Family charts show known categories only.',
  },
  {
    page: 'Market',
    source: 'Hover, focus, or tap a chart mark to',
    text: 'Hover, focus or tap a chart mark for its value. Expand the chart or open its values table.',
  },
  {
    page: 'Salary',
    source: 'Covers your reviewed jobs only: ads outside the',
    text: 'Salary facts cover reviewed jobs only. Details read since 2026-10-28 can have stored facts. Earlier jobs and unstated pay are excluded. Counts are not a market share.',
  },
  {
    page: 'Salary',
    source: 'Pay stated in NAV ad text. Each ad',
    text: 'Salary is stated in ad text. Each job counts once, by latest stored NAV version month in UTC. Brackets use midpoints.',
  },
  {
    page: 'Salary',
    source: 'Yearly equivalent: a year is used as stated,',
    text: 'Annual pay is unchanged. Monthly pay is multiplied by 12. Hourly pay is multiplied by 1,950, assuming 37.5 hours over 52 weeks.',
  },
  {
    page: 'Salary',
    source: 'Amounts without a stated or labelled period are',
    text: 'Amounts with no stated or labelled period enter counts only. Monthly medians exclude annual amounts outside the plausible range.',
  },
  {
    page: 'Salary',
    source: 'Left out: {n} salary rows of your reviewed',
    text: 'Reviewed-job salary rows without a usable date are excluded. The exclusion count is not exported here.',
  },
  {
    page: 'Salary',
    source: 'Not in these statistics: {n} with SKO, lønnstrinn',
    text: 'Salary statistics exclude vague pay, SKO, lønnstrinn, maximum-only amounts, unusable periods and amounts outside the plausible range. Exclusion counts and plausible ranges remain in the old salary view.',
  },
  {
    page: 'Salary',
    source: 'Each bar runs from the lowest to the',
    text: "Bars show each family's annual range. Boxes show the middle half; lines show the median. Both need five numeric brackets.",
  },
  {
    page: 'Salary',
    source: 'Select a column heading to sort when scripts',
    text: 'Select a column heading to sort. Sorting needs scripts.',
  },
  {
    page: 'Salary',
    source: 'NAV ad last changed is detail_changed, the NAV',
    text: 'The date is the stored NAV version time, not extraction time. The store has no extraction timestamp.',
  },
  {
    page: 'Salary',
    source: 'Amounts outside the plausible yearly range stay in',
    text: 'Out-of-range amounts remain labelled in the table. They are excluded from statistics, spread, medians and highest/lowest lists.',
  },
  {
    page: 'Salary',
    source: 'Closed ads keep their salary fact. Their title,',
    text: 'Closed jobs keep salary facts, but not titles, employers or role families. Their source links may no longer work.',
  },
  {
    page: 'Shortlist',
    source: 'Best current opportunities',
    text: 'The shortlist keeps the best qualifying saved matches.',
  },
  {
    page: 'Shortlist',
    source: 'Good matches stay here across refreshes, until closed',
    text: 'Matches stay across refreshes until source evidence closes or expires them.',
  },
  {
    page: 'Shortlist',
    source: 'New borders stay until you see a job,',
    text: 'The old shortlist highlights unseen jobs, then keeps the highlight for three days. Seen state is browser-local. Another browser can show them as new.',
  },
  {
    page: 'Shortlist',
    source: 'Enable JavaScript to remember which jobs you have',
    text: 'Browser-local seen tracking needs JavaScript.',
  },
] as const;
