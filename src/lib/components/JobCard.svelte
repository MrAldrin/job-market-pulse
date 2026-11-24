<script lang="ts">
  import type { Snippet } from 'svelte';
  import { isNew, relativeTime, shortDate } from '../format';
  import type { Job } from '../snapshot';
  import DistanceTag from './DistanceTag.svelte';
  import FitBadge from './FitBadge.svelte';

  let {
    job,
    now,
    radius = null,
    variant = 'card',
    actions,
  }: {
    job: Job;
    now: Date;
    radius?: number | null;
    variant?: 'card' | 'row';
    actions?: Snippet | undefined;
  } = $props();

  const uid = $props.id();
</script>

<article
  aria-labelledby="{uid}-title"
  data-variant={variant}
  class="min-w-0 rounded-lg border border-border bg-card text-card-foreground {variant ===
  'row'
    ? 'flex flex-wrap items-center gap-3 p-3'
    : 'space-y-3 p-4'}"
>
  <div class="flex flex-wrap items-center gap-2">
    <FitBadge fit={job.assessment.fit} />
    <DistanceTag {job} {radius} />
    {#if isNew(job, now)}<span
        class="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
        >New</span
      >{/if}
    {#if job.status === 'closed'}<span
        class="rounded-full border px-2 py-0.5 text-xs font-medium">Closed</span
      >{/if}
  </div>
  <h2
    id="{uid}-title"
    class="min-w-0 flex-1 text-lg leading-snug font-semibold [overflow-wrap:anywhere]"
  >
    <a
      href="#/jobs/{encodeURIComponent(job.id)}"
      class="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >{job.title || 'Title unknown'}</a
    >
  </h2>
  <p class="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
    {job.employer || 'Employer unknown'}{variant === 'card'
      ? ` · ${job.locations.join(', ') || 'Location unknown'}`
      : ''}
  </p>
  {#if variant === 'card'}
    <p class="line-clamp-3 [overflow-wrap:anywhere]">
      {job.assessment.reason || 'No review reason.'}
    </p>
  {/if}
  {#if job.assessment.hard_constraints === 'fail'}
    <p class="text-sm font-medium">Fails a hard limit</p>
  {:else if job.assessment.hard_constraints === 'unknown'}
    <p class="text-sm font-medium">Hard limits not confirmed</p>
  {/if}
  <footer
    class="flex min-w-0 flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
  >
    <span>Found {relativeTime(job.first_found_at, now)}</span>
    {#if variant === 'card' && job.expires_at !== null}<span
        >Listing expires {shortDate(job.expires_at)}</span
      >{/if}
  </footer>
  {#if actions}<div class="ml-auto flex min-w-0 flex-wrap justify-end gap-2">
      {@render actions()}
    </div>{/if}
</article>
