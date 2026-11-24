<script lang="ts">
  import { capturedPipelineSteps, pipelineSteps } from '../pipeline-flow';
  import type { Snapshot } from '../snapshot';

  let { snapshot }: { snapshot: Snapshot } = $props();
  const steps = $derived(capturedPipelineSteps(snapshot));
</script>

<section aria-labelledby="how-it-works" class="rounded-lg border bg-card p-4">
  <h2 id="how-it-works" class="text-lg font-semibold">How jobs reach the shortlist</h2>
  <p class="mt-1 text-sm text-muted-foreground">
    This is the job review flow, not a run log. Optional steps appear only if the snapshot shows they were enabled.
  </p>
  <ol aria-label="Job review steps" class="mt-4">
    {#each steps as id, index (id)}
      {@const step = pipelineSteps[id]}
      <li class="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 pb-4 last:pb-0">
        {#if index < steps.length - 1}
          <span aria-hidden="true" class="absolute start-[0.875rem] top-7 bottom-0 border-s"></span>
        {/if}
        <span aria-hidden="true" class="grid size-7 place-items-center rounded-full bg-secondary text-sm font-medium text-secondary-foreground">
          {index + 1}
        </span>
        <div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 class="font-medium">{step.label}</h3>
            <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{step.kind}</span>
          </div>
          <p class="mt-1 text-sm text-muted-foreground">{step.detail}</p>
        </div>
      </li>
    {/each}
  </ol>
</section>
