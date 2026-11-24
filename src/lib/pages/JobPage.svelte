<script lang="ts">
  import EmptyState from '../components/EmptyState.svelte';
  import JobDetail from '../components/JobDetail.svelte';
  import FeedbackControls from '../components/FeedbackControls.svelte';
  import type { FeedbackStore } from '../feedbackStore.svelte';
  import { jobById, type Snapshot } from '../snapshot';

  let {
    snapshot,
    id,
    now,
    feedback,
  }: { snapshot: Snapshot; id: string; now: Date; feedback?: FeedbackStore | undefined } =
    $props();

  const job = $derived(jobById(snapshot, id));
</script>

<svelte:head>
  <title
    >{job?.title || (job ? 'Title unknown' : 'Job not found')} · Job Market Pulse</title
  >
</svelte:head>

{#if job}
  {#snippet actions()}<FeedbackControls
      jobId={job.id}
      store={feedback}
    />{/snippet}
  <JobDetail
    {job}
    {now}
    actions={feedback?.available && Object.hasOwn(feedback.states, job.id)
      ? actions
      : undefined}
  />
{:else}
  <EmptyState
    title="This job is not in the current snapshot"
    text="Return to the saved jobs to choose another job."
    linkHref="#/jobs"
    linkText="Back to jobs"
  />
{/if}
