<script lang="ts">
  import AboutData from '../components/AboutData.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import FeedbackControls from '../components/FeedbackControls.svelte';
  import JobsReviewCard from '../components/JobsReviewCard.svelte';
  import Button from '../components/ui/button/Button.svelte';
  import { fitLabel } from '../format';
  import type { FeedbackStore } from '../feedbackStore.svelte';
  import {
    defaultJobFilters,
    filterJobs,
    jobsHash,
    jobsInView,
    type JobFilters,
  } from '../jobfilter';
  import { FIT_ORDER, type Fit, type Snapshot } from '../snapshot';

  let {
    snapshot,
    now,
    filters = defaultJobFilters(),
    feedback,
  }: {
    snapshot: Snapshot;
    now: Date;
    filters?: JobFilters | undefined;
    feedback?: FeedbackStore | undefined;
  } = $props();

  const savedIds = $derived(
    feedback?.available
      ? new Set(
          Object.entries(feedback.states)
            .filter(([, state]) => state.starred)
            .map(([id]) => id),
        )
      : undefined,
  );

  const population = $derived(jobsInView(snapshot, filters.view));
  const jobs = $derived(filterJobs(population, filters, savedIds));

  const viewLabels = {
    closed: 'Closed jobs in review history',
    'run-reviewed': 'Listed jobs judged in this run’s pool',
    'run-recommended': 'Recommended jobs in this run’s pool',
  };

  function update(change: Partial<JobFilters>): void {
    window.location.hash = jobsHash({ ...filters, ...change });
  }

  function setFit(fit: Fit, checked: boolean): void {
    // An empty set means no fit restriction. Keep each check independent.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const fits = new Set(filters.fits);

    if (checked) fits.add(fit);
    else fits.delete(fit);
    update({ fits });
  }

  function clear(): void {
    window.location.hash = jobsHash({
      ...defaultJobFilters(),
      fits: new Set(),
    });
  }

</script>

<div class="space-y-4">
  <h1 class="text-2xl font-semibold">Jobs</h1>
  {#if filters.view}
    <p>{viewLabels[filters.view]} · <a class="underline" href="#/jobs">Clear view</a></p>
  {/if}
  <div class="space-y-3 rounded-lg border bg-muted p-4">
    <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <label class="block min-w-0 space-y-1">
        <span class="block text-sm font-medium">Search title or employer</span>
        <input
          type="search"
          value={filters.query}
          oninput={(event) => update({ query: event.currentTarget.value })}
          class="min-h-11 w-full rounded-md border border-control bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-control"
        />
      </label>
      <fieldset class="min-w-0">
        <legend class="mb-1 text-sm font-medium">Filter by fit</legend>
        <div class="flex flex-wrap gap-2">
          {#each FIT_ORDER as fit (fit)}
            <label class="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-control bg-background px-2.5 py-1 text-sm hover:bg-accent has-checked:bg-signal-active has-checked:text-signal-active-foreground">
              <input
                type="checkbox"
                checked={filters.fits.has(fit)}
                onchange={(event) => setFit(fit, event.currentTarget.checked)}
                class="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-active-foreground"
              />
              {fitLabel(fit)} ({population.filter((job) => job.assessment.fit === fit).length})
            </label>
          {/each}
        </div>
      </fieldset>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {#if feedback?.available}
        <Button
          variant="outline"
          class="min-h-11"
          aria-pressed={filters.savedOnly}
          onclick={() => update({ savedOnly: !filters.savedOnly })}
        >Saved</Button>
      {/if}
      {#if filters.view !== 'closed'}
        <label class="flex min-h-11 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.showClosed}
            onchange={(event) => update({ showClosed: event.currentTarget.checked })}
            class="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-active-foreground"
          />Include closed ads
        </label>
      {/if}
      <label class="flex items-center gap-2">
        Sort
        <select
          value={filters.sort}
          onchange={(event) => update({ sort: event.currentTarget.value as JobFilters['sort'] })}
          class="min-h-11 rounded-md border border-control bg-background px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-control"
        >
          <option value="fit">Fit</option>
          <option value="newest">Newest first</option>
          <option value="employer">Employer</option>
        </select>
      </label>
    </div>
    <p aria-live="polite" class="text-sm">{jobs.length} of {population.length} jobs{filters.fits.size === 0 ? ' · All fit levels' : ''}</p>
  </div>
  {#if jobs.length}
    <section class="space-y-2" aria-labelledby="review-queue-title">
      <h2 id="review-queue-title" class="text-lg font-semibold">Review queue</h2>
      <ul class="grid min-w-0 gap-2" role="list">
        {#each jobs as job (job.id)}
          <li class="min-w-0">
            {#snippet actions()}<FeedbackControls jobId={job.id} store={feedback} />{/snippet}
            <JobsReviewCard
              {job}
              {now}
              radius={'settings' in snapshot ? snapshot.settings.filters.radius_km : null}
              actions={feedback?.available && Object.hasOwn(feedback.states, job.id) ? actions : undefined}
            />
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <EmptyState
      title={population.length
        ? 'No job matches these filters'
        : 'No AI reviews yet'}
      text={population.length
        ? 'Change the filters to see more reviewed jobs.'
        : 'Saved AI reviews will appear here.'}
    />
    <Button onclick={clear}>Clear filters</Button>
  {/if}
  <AboutData
    items={[
      { title: 'Coverage', text: snapshot.source.coverage_note },
      {
        title: 'AI review',
        text: 'Fit labels are AI assessments, not independently verified facts. Closed jobs keep their saved reviews.',
      },
    ]}
  />
</div>
