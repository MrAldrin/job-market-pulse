<script lang="ts">
  import type { Snippet } from 'svelte';
  import { isNew } from '../format';
  import { canGoBackInApp } from '../router';
  import type { Job } from '../snapshot';
  import FitBadge from './FitBadge.svelte';
  import JobReview from './JobReview.svelte';

  let { job, now, actions }: { job: Job; now: Date; actions?: Snippet | undefined } =
    $props();
</script>

<article class="min-w-0 space-y-6 [overflow-wrap:anywhere]">
  <a
    href="#/jobs"
    class="rounded-sm underline focus-visible:outline-2 focus-visible:outline-ring"
    onclick={(event) => {
      if ($canGoBackInApp) {
        event.preventDefault();
        history.back();
      }
    }}>Back to jobs</a
  >
  <header class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <FitBadge fit={job.assessment.fit} />
      {#if isNew(job, now)}<span
          class="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
          >New</span
        >{/if}
      {#if job.status === 'closed'}<span
          class="rounded-full border px-2 py-0.5 text-xs">Closed</span
        >{/if}
    </div>
    <h1 class="text-2xl font-semibold">{job.title || 'Title unknown'}</h1>
    <p class="text-muted-foreground">
      {job.employer || 'Employer unknown'} · {job.locations.join(', ') ||
        'Location unknown'}
    </p>
    <a
      href={job.url}
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex min-h-9 items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-ring"
      >Open the ad</a
    >
  </header>
  <JobReview {job} {now} />
  {#if actions}<div class="flex flex-wrap gap-2">{@render actions()}</div>{/if}
</article>
