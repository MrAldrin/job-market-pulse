<script lang="ts">
  import type { Snippet } from 'svelte';
  import { isNew } from '../format';
  import type { Job } from '../snapshot';
  import BoxedDisclosure from './BoxedDisclosure.svelte';
  import DistanceTag from './DistanceTag.svelte';
  import FitBadge from './FitBadge.svelte';
  import JobReview from './JobReview.svelte';

  let { job, now, radius, actions }: { job: Job; now: Date; radius: number | null; actions?: Snippet | undefined } = $props();
  let expanded = $state(false);
</script>

<BoxedDisclosure bind:open={expanded}>
  {#snippet summary()}
    <span class="block text-lg leading-snug font-semibold">{job.title || 'Title unknown'}</span>
    <span class="mt-0.5 block text-sm font-normal text-muted-foreground">{job.employer || 'Employer unknown'}</span>
    <span class="mt-2 flex flex-wrap items-center gap-2">
      <FitBadge fit={job.assessment.fit} />
      <DistanceTag {job} {radius} />
      <span class="rounded-full px-2.5 py-0.5 text-xs {job.status === 'closed'
        ? 'bg-signal-neutral text-signal-neutral-foreground'
        : 'bg-signal-active text-signal-active-foreground'}">
        {job.status === 'closed' ? 'Closed in saved data' : 'Open in saved data'}
      </span>
      {#if isNew(job, now)}
        <span class="rounded-full bg-signal-active px-2.5 py-0.5 text-xs text-signal-active-foreground">New</span>
      {/if}
    </span>
    {#if job.assessment.hard_constraints === 'fail'}
      <span class="mt-1 block text-sm">Fails a hard limit</span>
    {:else if job.assessment.hard_constraints === 'unknown'}
      <span class="mt-1 block text-sm">Hard limits not confirmed</span>
    {/if}
  {/snippet}
  {#if expanded}
    <div class="space-y-4">
      <p class="text-sm text-muted-foreground">{job.locations.join(', ') || 'Location unknown'}</p>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-active-foreground"
        >Open the ad</a>
        <a
          href="#/jobs/{encodeURIComponent(job.id)}"
          class="inline-flex min-h-11 items-center rounded-md text-sm underline focus-visible:outline-2 focus-visible:outline-signal-active-foreground"
        >Open job details</a>
      </div>
      <JobReview {job} {now} heading="h3" />
      {#if actions}
        <div class="flex flex-wrap gap-2">{@render actions()}</div>
      {/if}
    </div>
  {/if}
</BoxedDisclosure>
