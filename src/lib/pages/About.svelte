<script lang="ts">
  import { ABOUT_LIMITS } from '../aboutLimits';
  import BoxedDisclosure from '../components/BoxedDisclosure.svelte';
  import PipelineCounts from '../components/PipelineCounts.svelte';
  import PipelineFlow from '../components/PipelineFlow.svelte';
  import { elapsedAge, osloMinute } from '../format';
  import { searchModes } from '../search-mode';
  import type { Snapshot } from '../snapshot';

  let { snapshot, now }: { snapshot: Snapshot; now: Date } = $props();

  const snapshotTime = $derived(osloMinute(snapshot.generated_at));
  const sourceTime = $derived(osloMinute(snapshot.source.checked_at));

  const mode = $derived(searchModes[snapshot.profile.mode]);

  const fitMeanings = [
    ['Exceptional', 'The highest assessed fit. Check the evidence and hard limits.'],
    ['Strong', 'A close assessed fit.'],
    ['Possible', 'A job worth considering.'],
    ['Unknown', 'The AI review could not judge fit. Jobs show this as Not judged.'],
    ['Poor', 'A weak assessed fit, not an automatic rejection.'],
  ] as const;
</script>

<div class="space-y-8">
  <h1 class="text-2xl font-semibold">About</h1>
  <PipelineCounts {snapshot} />
  <PipelineFlow {snapshot} />

  <BoxedDisclosure>
    {#snippet summary()}Show feedback and repeat paths{/snippet}
    <div class="grid gap-3">
      <section aria-labelledby="reuse-review" class="rounded-md border p-3">
        <h2 id="reuse-review" class="font-medium">Reuse a compatible review</h2>
        {@render pathSteps(['Later refresh', 'Check eligibility and review inputs', 'Reuse saved decision', 'Selection'])}
        <p class="mt-2 text-sm text-muted-foreground">Pulse skips a new model call for that decision.</p>
      </section>
      <section aria-labelledby="suggest-settings" class="rounded-md border p-3">
        <h2 id="suggest-settings" class="font-medium">Suggest a Settings change</h2>
        {@render pathSteps(['Saved reviews or reactions', 'AI proposes a change', 'You approve in Settings', 'New rules or inputs for a later run'])}
        <p class="mt-2 text-sm text-muted-foreground">For example, AI can suggest a title exclusion. No approval means no change. Approval does not start a refresh.</p>
      </section>
      <section aria-labelledby="repeat-review" class="rounded-md border p-3">
        <h2 id="repeat-review" class="font-medium">Review selected levels again</h2>
        {@render pathSteps(['First assessed fit', 'Check levels selected in Settings', 'Optional second assessment', 'Accepted fit for selection'])}
        <p class="mt-2 text-sm text-muted-foreground">Only an accepted second assessment replaces the first in the shortlist. The review database keeps both.</p>
      </section>
    </div>
  </BoxedDisclosure>

  <section aria-labelledby="fit-levels" class="rounded-lg border bg-card p-4">
    <h2 id="fit-levels" class="text-lg font-semibold">Fit levels</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      Search mode at capture: <span class="font-medium text-foreground">{mode.label}.</span> {mode.help}
    </p>
    <dl class="mt-3 divide-y">
      {#each fitMeanings as [label, text] (label)}
        <div class="py-2 last:pb-0">
          <dt class="font-medium">{label}</dt>
          <dd class="text-sm text-muted-foreground">{text}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <section aria-labelledby="last-update" class="rounded-lg border bg-card p-4">
    <h2 id="last-update" class="text-lg font-semibold">Last update</h2>
    <p class="text-sm text-muted-foreground">Times shown in Oslo time.</p>
    <dl class="mt-3 grid gap-3 sm:grid-cols-2">
      <div>
        <dt class="text-sm text-muted-foreground">Snapshot created</dt>
        <dd>
          {#if snapshotTime}
            <time datetime={snapshot.generated_at}>{snapshotTime}</time> · {elapsedAge(snapshot.generated_at, now)}
          {:else}
            Time unknown
          {/if}
          <p class="text-sm text-muted-foreground">When Pulse saved this dashboard data.</p>
        </dd>
      </div>
      <div>
        <dt class="text-sm text-muted-foreground">Source</dt>
        <dd>{snapshot.source.name}</dd>
      </div>
      <div>
        <dt class="text-sm text-muted-foreground">Source check</dt>
        <dd>
          {#if sourceTime && snapshot.source.checked_at}
            <time datetime={snapshot.source.checked_at}>{sourceTime}</time> · {elapsedAge(snapshot.source.checked_at, now)}
          {:else}
            Source check unknown
          {/if}
          <p class="text-sm text-muted-foreground">When Pulse last read NAV for this snapshot.</p>
        </dd>
      </div>
      <div>
        <dt class="text-sm text-muted-foreground">Search mode</dt>
        <dd>
          {mode.label}
          <p class="text-sm text-muted-foreground">At snapshot creation: {mode.help}</p>
        </dd>
      </div>
    </dl>
    <div class="mt-4">
      <BoxedDisclosure>
        {#snippet summary()}About this data{/snippet}
        <div class="space-y-3 text-sm">
          <p class="text-muted-foreground">
            These notes explain this dashboard and the legacy views. Only exported
            fields establish facts about this snapshot.
          </p>
          <p class="text-muted-foreground">
            The snapshot does not show whether the source met the configured age limit.
            It has no application deadline, catch-up flag or complete run-status record.
            Do not infer delivery or refresh success.
          </p>
          <ul class="list-disc space-y-3 pl-5">
            {#each ABOUT_LIMITS as item (item.source)}
              <li data-caveat-source={item.source}>
                <span class="font-medium">{item.page}:</span>
                {item.text}
              </li>
            {/each}
          </ul>
        </div>
      </BoxedDisclosure>
    </div>
  </section>
</div>

{#snippet pathSteps(steps: readonly string[])}
  <ol role="list" class="mt-2 flex flex-col flex-wrap gap-1.5 text-sm font-medium md:flex-row">
    {#each steps as step, index (step)}
      <li class="flex items-baseline gap-1.5 rounded bg-muted px-2 py-1">
        {#if index > 0}<span aria-hidden="true" class="rotate-90 md:rotate-0">→</span>{/if}
        <span>{step}</span>
      </li>
    {/each}
  </ol>
{/snippet}
