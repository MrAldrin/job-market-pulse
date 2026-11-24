<script lang="ts">
  import { defaultJobFilters, jobsHash, jobsInView } from '../jobfilter';
  import { capturedPipelineSteps, pipelineSteps, type PipelineStepId } from '../pipeline-flow';
  import { searchModes } from '../search-mode';
  import type { Fit, Snapshot } from '../snapshot';

  let { snapshot }: { snapshot: Snapshot } = $props();
  const run = $derived('run_funnel' in snapshot ? snapshot.run_funnel : null);
  const pool = $derived(run?.pool);
  const mode = $derived(searchModes[snapshot.profile.mode]);
  const reviewedJobs = $derived(jobsInView(snapshot, 'run-reviewed'));
  const recommended = $derived(jobsInView(snapshot, 'run-recommended').length);
  const steps = $derived<PipelineStepId[]>(capturedPipelineSteps(snapshot).filter((step) => step !== 'alerts'));

  const fits = [
    ['exceptional', 'Exceptional'], ['strong', 'Strong'], ['possible', 'Possible'], ['unknown', 'Unknown'], ['poor', 'Poor'],
  ] as const satisfies readonly (readonly [Fit, string])[];

  const { reviewed, open, closed } = $derived(snapshot.counts);

  const history = $derived([
    { name: 'Reviewed', value: reviewed, href: jobsHash({ ...defaultJobFilters(), fits: new Set(), showClosed: true }) },
    { name: 'Open', value: open, href: jobsHash({ ...defaultJobFilters(), fits: new Set() }) },
    { name: 'Closed', value: closed, href: jobsHash({ ...defaultJobFilters(), fits: new Set(), view: 'closed', showClosed: true }) },
  ]);
</script>

<div class="grid items-start gap-4 lg:grid-cols-2">
  <section aria-labelledby="this-run" class="min-w-0 rounded-lg border bg-card p-4">
    <h2 id="this-run" class="text-lg font-semibold">This run’s pool</h2>
    {#if run}
      <p class="mt-1 text-sm text-muted-foreground">
        NAV sends changes. Pulse filters the saved pool, which can include jobs from earlier runs, and can reuse AI reviews.
      </p>
      <ol aria-label="Counts by pipeline step" class="mt-3 border-s ps-4">
        {#each steps as step (step)}
          {#if pool || step === 'source'}
            <li class="border-b py-3 last:border-b-0 last:pb-0">
              <h3 class="font-medium">{pipelineSteps[step].label}</h3>
              {#if step === 'source'}
                <p>{run.nav_events} feed changes read</p>
              {:else if step === 'locations'}
                <p class="text-sm text-muted-foreground">{pipelineSteps[step].detail}</p>
              {:else if pool && step === 'filters'}
                <p>{pool.filters.pool} saved ads to filter</p>
                <dl class="mt-1 grid max-w-sm grid-cols-[1fr_auto] gap-x-3 text-sm text-muted-foreground">
                  <dt>Removed by area rules</dt><dd>{pool.filters.area}</dd>
                  <dt>Removed by exclusion rules</dt><dd>{pool.filters.exclusions}</dd>
                  <dt>Removed by occupation rules</dt><dd>{pool.filters.occupation}</dd>
                  {#if pool.filters.other}<dt>Unusable or expired</dt><dd>{pool.filters.other}</dd>{/if}
                  <dt class="font-medium text-foreground">Eligible after filters</dt><dd class="text-foreground">{snapshot.counts.eligible}</dd>
                </dl>
              {:else if pool && step === 'screen'}
                <dl class="mt-1 grid max-w-sm grid-cols-[1fr_auto] gap-x-3 text-sm text-muted-foreground">
                  <dt>Screened out by title</dt><dd>{pool.screen.out}</dd>
                  <dt>No saved title decision</dt><dd>{pool.screen.undecided}</dd>
                  <dt class="font-medium text-foreground">Passed to AI judge</dt><dd class="text-foreground">{pool.screen.advanced}</dd>
                </dl>
              {:else if pool && step === 'judge'}
                <p>{pool.screen.advanced - pool.judge.unfinished} with a saved full review</p>
                <p class="text-sm text-muted-foreground">{pool.judge.unfinished} without a saved full review</p>
                <dl class="mt-1 grid max-w-sm grid-cols-[1fr_auto] gap-x-3 text-sm">
                  {#each fits as [fit, label] (fit)}
                    {@const listed = reviewedJobs.filter((job) => job.assessment.fit === fit).length}
                    <dt>{label}</dt>
                    <dd>
                      {#if listed > 0 && listed === pool.judge.fits[fit]}
                        <a class="underline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`View ${listed} ${label} jobs from this run’s pool`} href={jobsHash({ ...defaultJobFilters(), fits: new Set([fit]), view: 'run-reviewed', showClosed: true })}>{listed}</a>
                      {:else}
                        {pool.judge.fits[fit]}
                      {/if}
                    </dd>
                  {/each}
                </dl>
              {:else if pool && step === 'rejudge'}
                <p class="text-sm text-muted-foreground">The fit counts above use the saved repeat review when it belongs to that job’s current review.</p>
              {:else if pool}
                <p>
                  {#if recommended > 0}
                    <a class="underline focus-visible:outline-2 focus-visible:outline-ring" href={jobsHash({ ...defaultJobFilters(), fits: new Set(), view: 'run-recommended' })}>{recommended} recommended</a>
                  {:else}
                    0 recommended
                  {/if}
                  · {mode.label}
                </p>
                <p class="text-sm text-muted-foreground">{pool.screen.advanced - pool.judge.unfinished - recommended} judged jobs from this pool did not make the saved recommendations.</p>
              {/if}
            </li>
          {/if}
        {/each}
      </ol>
      {#if pool}
        <p class="mt-3 border-t pt-3 text-sm text-muted-foreground">
          Among jobs without a saved title decision or full review: {pool.waiting} waiting · {pool.failed} failed or blocked.
        </p>
      {:else}
        <p class="mt-3 text-sm text-muted-foreground">The saved data did not establish the current pool counts.</p>
      {/if}
    {:else}
      <p class="mt-1 text-sm text-muted-foreground">This snapshot has no run counts. A new refresh saves them.</p>
    {/if}
  </section>

  <section aria-labelledby="review-history" class="min-w-0 rounded-lg border bg-card p-4">
    <h2 id="review-history" class="text-lg font-semibold">Review history</h2>
    <p class="mt-1 text-sm text-muted-foreground">These are the reviews saved in this snapshot, from this run or earlier runs. Closed includes expired ads.</p>
    {#if reviewed > 0 && open + closed === reviewed}
      <div aria-hidden="true" class="my-3 flex h-2 overflow-hidden rounded-full bg-muted">
        <span class="bg-signal-active-foreground" style:width={`${open / reviewed * 100}%`}></span>
        <span class="bg-signal-neutral-foreground" style:width={`${closed / reviewed * 100}%`}></span>
      </div>
    {/if}
    <dl class="mt-3 grid grid-cols-3 gap-2 text-sm">
      {#each history as item (item.name)}
        <div>
          <dt>{item.name}</dt>
          <dd class="text-lg font-medium tabular-nums">
            {#if item.value > 0 && snapshot.jobs.filter((job) => item.name === 'Reviewed' || job.status === item.name.toLowerCase()).length === item.value}
              <a class="underline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`View ${item.value} ${item.name.toLowerCase()} jobs in review history`} href={item.href}>{item.value}</a>
            {:else}
              {item.value}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  </section>
</div>
