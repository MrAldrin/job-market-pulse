<script lang="ts">
  import AboutData from '../components/AboutData.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import JobCard from '../components/JobCard.svelte';
  import FeedbackControls from '../components/FeedbackControls.svelte';
  import type { FeedbackStore } from '../feedbackStore.svelte';
  import { count, isNew } from '../format';
  import { shortlistJobs, type Snapshot } from '../snapshot';

  let {
    snapshot,
    now,
    feedback,
  }: { snapshot: Snapshot; now: Date; feedback?: FeedbackStore | undefined } = $props();

  const jobs = $derived(shortlistJobs(snapshot));
  const newCount = $derived(jobs.filter((job) => isNew(job, now)).length);

  const allJobsLink = $derived(
    `See all ${snapshot.counts.reviewed} reviewed jobs`,
  );
</script>

<div class="space-y-4">
  <header class="space-y-1">
    <h1 class="text-2xl font-semibold">
      {jobs.length
        ? count(jobs.length, 'recommended job', 'recommended jobs')
        : 'No recommendations right now'}
    </h1>
    {#if newCount}<p class="text-muted-foreground">
        {newCount} new this week
      </p>{/if}
  </header>
  {#if jobs.length}
    <div class="grid min-w-0 gap-4">
      {#each jobs as job (job.id)}
        {#snippet actions()}<FeedbackControls
            jobId={job.id}
            store={feedback}
          />{/snippet}
        <JobCard
          {job}
          {now}
          radius={'settings' in snapshot ? snapshot.settings.filters.radius_km : null}
          actions={feedback?.available && Object.hasOwn(feedback.states, job.id)
            ? actions
            : undefined}
        />
      {/each}
    </div>
    <a
      class="inline-block underline focus-visible:outline-2 focus-visible:outline-ring"
      href="#/jobs">{allJobsLink}</a
    >
  {:else}
    <EmptyState
      title="No current recommendations"
      text="No job passed the bar. That is a normal result."
      linkHref="#/jobs"
      linkText={allJobsLink}
    />
  {/if}
  <AboutData
    items={[
      { title: 'Selection', text: snapshot.shortlist.rule },
      { title: 'Coverage', text: snapshot.source.coverage_note },
    ]}
  />
</div>
