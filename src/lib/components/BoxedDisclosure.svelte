<script lang="ts">
  import type { Snippet } from 'svelte';

  let { summary, children, open = $bindable(false) }: {
    summary: Snippet;
    children: Snippet;
    open?: boolean;
  } = $props();
</script>

<details
  bind:open
  class="group/disclosure min-w-0 rounded-lg border border-control bg-card text-card-foreground open:border-signal-active-foreground"
>
  <summary
    class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-active-foreground group-open/disclosure:rounded-b-none group-open/disclosure:bg-accent [&::-webkit-details-marker]:hidden"
  >
    <span class="min-w-0 [overflow-wrap:anywhere]">{@render summary()}</span>
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      class="size-4 shrink-0 group-open/disclosure:rotate-180"
    >
      <path d="m3 6 5 5 5-5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" />
    </svg>
  </summary>
  <div class="min-w-0 border-t border-border p-4 [overflow-wrap:anywhere]">
    {@render children()}
  </div>
</details>
