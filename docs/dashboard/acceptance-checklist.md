# Dashboard acceptance checklist

Use these checks on desktop and phone. Tick a box only after you do the
check. A synthetic demo is not proof of behavior with real data.

Run locally with `pulse demo` or, on real data, `pulse snapshot export` and then
`pulse dashboard`. The hosted copy is at `/app/` on the Railway viewer.

## Layout and reading

- [ ] **Best jobs first.** Open Home on a phone.
  Expected: the first job card shows without scrolling.
- [ ] **Phone width.** Open Home, Jobs, a job detail, Market, Salary and About at 375 px.
  Expected: no horizontal scroll.
- [ ] **Zoom 200 %.** Zoom the browser to 200 % on each page.
  Expected: no text is cut off and no horizontal scroll.
- [ ] **Dark mode.** Set the phone or desktop to dark mode and open Home.
  Expected: a dark page with readable text.

## Keyboard

- [ ] **Keyboard only.** Use only Tab, Shift+Tab, Enter and Space.
  Expected: a "Skip to content" link first, then the nav, search, fit filters,
  sort and the feedback buttons, each with a visible focus ring.

## State

- [ ] **Filters survive Back and reload.** On Jobs, change a fit filter, open a job,
  press Back, then reload.
  Expected: the same filters are on.
- [ ] **Star and thumbs survive reload.** Press Save on a job, then reload.
  Expected: the job is still saved.
- [ ] **Missing job.** Open `#/jobs/does-not-exist`.
  Expected: a clear message and a link back to Jobs.
- [ ] **Charts.** Where a chart offers a values table, check that the table and chart agree.

## Hosted copy (owner only)

Follow the [Railway release checks](../operations/railway.md#release-and-manual-acceptance).
Test stars and reactions on the local dashboard, not the Railway copy.
A job-applications consumer that uses the Railway URL can no longer pull stars.
See [consumer impact](../operations/railway.md#read-only-starred-job-export).
