<script lang="ts">
  import { tick } from 'svelte';
  import type { LocalRunLogEntry } from '../contracts/local-run';
  import type { StageName } from '../contracts/pipeline-progress';

  let { lines, stageLabels }: {
    lines: readonly (typeof LocalRunLogEntry.Type)[];
    stageLabels: Record<StageName, string>;
  } = $props();

  let viewport: HTMLDivElement | undefined;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  $effect.pre(() => {
    // Only follow new entries while the reader is already at the bottom.
    if (!lines.length) return;

    if (viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8) return;
    void tick().then(() => {
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  });
</script>

<section aria-labelledby="refresh-log-title" class="space-y-2 rounded-md border bg-card p-4 text-card-foreground">
  <h2 id="refresh-log-title" class="text-lg font-semibold">Refresh log</h2>
  <p class="text-sm text-muted-foreground">Oslo time · Up to 2,000 entries for the latest refresh in this session.</p>
  {#if lines[0] && lines[0].sequence > 1}
    <p class="text-sm text-muted-foreground">Older entries are no longer available.</p>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the log.) -->
  <div
    role="log"
    aria-labelledby="refresh-log-title"
    aria-relevant="additions"
    tabindex="0"
    bind:this={viewport}
    class="max-h-[55vh] overflow-y-auto rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
  >
    {#if lines.length === 0}
      <p class="py-2 text-muted-foreground">No log entries in this dashboard session.</p>
    {:else}
      <ol class="divide-y">
        {#each lines as line (line.sequence)}
          <li class="break-words py-2">
            <div class="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <time class="tabular-nums" datetime={line.time}>{clock.format(new Date(line.time))}</time>
              <span>{line.stage ? stageLabels[line.stage] : 'Refresh'}</span>
              {#if line.level !== 'info'}<span class="font-semibold">{line.level === 'error' ? 'Error' : 'Warning'}</span>{/if}
            </div>
            <p>{line.message}</p>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</section>
