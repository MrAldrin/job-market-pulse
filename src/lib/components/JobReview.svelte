<script lang="ts">
  import { relativeTime, shortDate } from '../format';
  import type { Job } from '../snapshot';
  import FitBadge from './FitBadge.svelte';

  let { job, now, heading = 'h2' }: { job: Job; now: Date; heading?: 'h2' | 'h3' } = $props();

  const verdict = $derived(
    { pass: 'Pass', fail: 'Fail', unknown: 'Not confirmed' }[job.assessment.hard_constraints],
  );
</script>

{#if !job.assessment.ad_text_reviewed}
  <p class="rounded-md border p-3 text-sm">No full ad text was reviewed.</p>
{/if}
<section class="space-y-2">
  <svelte:element this={heading} class="font-semibold">Why this fit</svelte:element>
  <p class="whitespace-pre-line">{job.assessment.reason || 'No review reason.'}</p>
</section>
{#if job.assessment.evidence.length}
  <section class="space-y-2">
    <svelte:element this={heading} class="font-semibold">Evidence from the ad</svelte:element>
    <ul class="list-disc space-y-1 pl-5">
      {#each job.assessment.evidence as quote, i (i)}
        <li><blockquote>{quote}</blockquote></li>
      {/each}
    </ul>
  </section>
{/if}
{#if job.assessment.uncertainties.length}
  <section class="space-y-2">
    <svelte:element this={heading} class="font-semibold">Check before applying</svelte:element>
    <ul class="list-disc space-y-1 pl-5">
      {#each job.assessment.uncertainties as question, i (i)}
        <li>{question}</li>
      {/each}
    </ul>
  </section>
{/if}
{#if 'rejudge' in job && job.rejudge}
  <section aria-label="Repeat review" class="space-y-2 rounded-md border bg-muted p-3 text-sm">
    <svelte:element this={heading} class="font-semibold">Repeat review</svelte:element>
    <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>First <FitBadge fit={job.rejudge.first_fit} /></span>
      <span aria-hidden="true">→</span>
      <span>Accepted <FitBadge fit={job.assessment.fit} /></span>
    </p>
    <p>First model: {job.rejudge.first_model ?? 'Unknown'}</p>
    <p>Re-judge model: {job.rejudge.model ?? 'Unknown'}</p>
  </section>
{/if}
<table class="w-full text-left text-sm">
  <caption class="mb-2 text-left font-semibold">Job facts</caption>
  <tbody>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">Hard limits</th><td>{verdict}</td></tr>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">Ad text read</th><td>{job.assessment.ad_text_reviewed ? 'Yes' : 'No'}</td></tr>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">First found</th><td>{shortDate(job.first_found_at)} · {relativeTime(job.first_found_at, now)}</td></tr>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">Reviewed</th><td>{shortDate(job.reviewed_at)}</td></tr>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">Listing expires</th><td>{shortDate(job.expires_at)}</td></tr>
    <tr class="border-b"><th scope="row" class="py-2 pr-4">Status</th><td>{job.status === 'closed' ? 'Closed' : 'Open in saved data'}</td></tr>
  </tbody>
</table>
