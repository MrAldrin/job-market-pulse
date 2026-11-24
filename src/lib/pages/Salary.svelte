<script lang="ts">
  import AboutData from '../components/AboutData.svelte';
  import DataTable from '../components/DataTable.svelte';
  import BoxedDisclosure from '../components/BoxedDisclosure.svelte';
  import SalaryChart from './SalaryChart.svelte';
  import { projectSalary } from '../dashboard/salary-view';
  import type { Snapshot } from '../snapshot';

  let { snapshot }: { snapshot: Snapshot } = $props();

  const salary = $derived(projectSalary(snapshot));

  const latest = $derived(salary.state === 'unavailable' ? undefined : salary.monthly.at(-1));
  const formatPay = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

  const missing = 'Not recorded';
  const forms = { range: 'Range', single: 'Single amount', max: 'Maximum only', vague: 'No specific amount' };
  const periods = { year: 'Year', month: 'Month', hour: 'Hour' };

  const monthlyColumns = [
    { key: 'month', label: 'Month (UTC)' },
    { key: 'median', label: 'Median (NOK/year)', numeric: true },
    { key: 'mean', label: 'Mean (NOK/year)', numeric: true },
    { key: 'range', label: 'Observed low–high (NOK/year)' },
    { key: 'facts', label: 'Salary facts', numeric: true },
    { key: 'numeric', label: 'Eligible numeric facts', numeric: true },
    { key: 'vague', label: 'Pay codes or vague pay', numeric: true },
  ];
</script>

<div class="space-y-5">
  <h1 class="text-2xl font-semibold">Salary</h1>
  <p>Pay disclosed in reviewed ads</p>

  {#if salary.state === 'unavailable'}
    <p>Salary facts unavailable.</p>
  {:else if salary.state === 'empty'}
    <p>No stated salary facts.</p>
  {:else}
    {#if latest}
      <section class="space-y-1 rounded-lg border bg-card p-4" aria-label="Latest salary month">
        <h2 class="font-semibold">{latest.month} · Median pay (NOK/year)</h2>
        <p class="text-2xl font-semibold tabular-nums">{latest.hidden ? 'Hidden' : latest.median_yearly === null ? missing : formatPay.format(latest.median_yearly)}</p>
        <p class="text-sm">n={latest.numeric} eligible ads{latest.hidden ? ' · Fewer than 5' : ''}</p>
      </section>
    {:else}
      <p>No dated monthly salary statistics.</p>
    {/if}
    <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
    {#if latest}
      <section class="min-w-0 space-y-3">
        <SalaryChart months={salary.monthly} />
        <BoxedDisclosure open>
          {#snippet summary()}Show values{/snippet}
          <DataTable columns={monthlyColumns} caption="Monthly salary statistics and counts"
            rows={salary.monthly.map((month) => ({ month: month.month,
              median: month.median_yearly ?? (month.hidden ? 'Hidden: fewer than 5 eligible facts' : missing),
              mean: month.hidden ? 'Hidden' : month.stats ? formatPay.format(month.stats.mean) : missing,
              range: month.hidden ? 'Hidden' : month.stats ? `${formatPay.format(month.stats.low)}–${formatPay.format(month.stats.high)}` : missing,
              facts: month.facts, numeric: month.numeric, vague: month.sko_or_vague }))} />
        </BoxedDisclosure>
      </section>
    {/if}
    {#if salary.ads.length}
      <section class="space-y-3">
        <h2 class="text-xl font-semibold">Saved facts by job</h2>
        <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {#each salary.ads as { fact, jobLink } (fact.job_id)}
            <li class="min-w-0 space-y-2 rounded-lg border p-4 text-sm [overflow-wrap:anywhere]">
              <h3 class="font-semibold">{fact.title ?? 'Title not recorded'}</h3>
              <p>{fact.employer ?? 'Employer not recorded'}</p>
              {#if fact.closed}<p class="font-medium">Closed</p>{/if}
              <dl class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>NAV version (UTC)</dt><dd>{fact.changed}</dd>
                <dt>Pay form</dt><dd>{fact.form === null ? missing : forms[fact.form]}</dd>
                <dt>Lower amount (NOK)</dt><dd>{fact.low ?? missing}</dd>
                <dt>Upper amount (NOK)</dt><dd>{fact.high ?? missing}</dd>
                <dt>Pay period</dt><dd>{fact.period === null ? missing : periods[fact.period]}{fact.period_inferred ? ' (inferred)' : ''}</dd>
                <dt>Yearly equivalent midpoint (NOK)</dt><dd>{fact.yearly_midpoint ?? missing}</dd>
                {#if fact.sko_code !== null}<dt>SKO code</dt><dd>{fact.sko_code}</dd>{/if}
                {#if fact.ltr_min !== null || fact.ltr_max !== null}
                  <dt>Lower pay step</dt><dd>{fact.ltr_min ?? missing}</dd>
                  <dt>Upper pay step</dt><dd>{fact.ltr_max ?? missing}</dd>
                {/if}
              </dl>
              {#if fact.sko_or_vague}<p>Pay code or vague pay</p>{/if}
              {#if fact.outside_plausible_range}<p>Outside the plausible yearly range</p>{/if}
              {#if jobLink}
                <a class="underline focus-visible:outline-2 focus-visible:outline-ring" href="#/jobs/{encodeURIComponent(jobLink.id)}"
                  aria-label={fact.title ? `View job review: ${fact.title}` : `View job review: ${fact.job_id}`}>View job review</a>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <p>No dated per-job salary facts.</p>
    {/if}
    </div>
  {/if}

  <AboutData items={[
    { title: 'Sample', text: 'Facts come from saved NAV ad text for reviewed jobs only. Earlier jobs and jobs with no stated pay may have no facts. Counts are not market shares.' },
    { title: 'Dates', text: 'Each job counts once, by stored NAV version month in UTC, not by extraction date.' },
    ...(salary.state === 'unavailable' ? [] : [{ title: 'Undated facts', text: `Salary rows excluded for no usable date: ${salary.undated}.` }]),
    { title: 'Yearly equivalents', text: 'The saved statistics use bracket midpoints. Annual pay is unchanged. Monthly pay is multiplied by 12. Hourly pay is multiplied by 1,950, assuming 37.5 hours over 52 weeks.' },
    { title: 'Monthly pay', text: 'Months without a saved median leave gaps. Statistics are hidden below five eligible facts. Mean and observed low–high use the same yearly midpoints as the median and require the full matching sample. Maximum-only amounts, code-only pay, vague pay and amounts with no usable period do not qualify. Yearly amounts outside NOK 150,000 to 3,000,000 do not qualify.' },
    { title: 'Closed jobs', text: 'Closed jobs can retain salary facts without a title or employer. A saved review does not confirm a current opening.' },
    { title: 'Saved data', text: 'This page does not refresh the source.' },
  ]} />
</div>
