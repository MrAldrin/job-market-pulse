<script lang="ts">
  import type { FeedbackStore } from '../feedbackStore.svelte';
  import Button from './ui/button/Button.svelte';

  let { jobId, store }: { jobId: string; store?: FeedbackStore | undefined } = $props();

  const state = $derived(
    store?.available && Object.hasOwn(store.states, jobId)
      ? store.states[jobId]
      : undefined,
  );
</script>

{#if state && store}
  <div class="min-w-0 space-y-2">
    <div role="group" aria-label="Your feedback" class="flex flex-wrap gap-2">
      <Button
        variant="outline"
        class="min-h-11 min-w-11"
        aria-pressed={state.starred}
        onclick={() => {
          void store?.setStar(jobId, !state?.starred);
        }}><svg aria-hidden="true" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>Save</Button
      >
      <Button
        variant="outline"
        class="min-h-11 min-w-11"
        aria-pressed={state.reaction === 'up'}
        onclick={() => {
          void store?.setReaction(jobId, 'up');
        }}><svg aria-hidden="true" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M14 5.88 13 10h6.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 2 3.88Z" /></svg>Good match</Button
      >
      <Button
        variant="outline"
        class="min-h-11 min-w-11"
        aria-pressed={state.reaction === 'down'}
        onclick={() => {
          void store?.setReaction(jobId, 'down');
        }}><svg aria-hidden="true" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2M10 18.12 11 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-2-3.88Z" /></svg>Not for me</Button
      >
    </div>
    {#if store.errors[jobId]}
      <div class="flex flex-wrap items-center gap-2">
        <p role="status" class="text-sm">{store.errors[jobId]}</p>
        <Button
          class="min-h-11 min-w-11"
          disabled={store.pending[jobId]}
          onclick={() => {
            void store?.retry(jobId);
          }}>Retry</Button
        >
      </div>
    {/if}
  </div>
{/if}
