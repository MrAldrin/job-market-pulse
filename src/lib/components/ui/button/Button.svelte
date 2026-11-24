<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';

  // shadcn-svelte Button, limited to its native default-button API.
  // Source: https://www.shadcn-svelte.com/docs/components/button
  let {
    class: className,
    variant = 'default',
    type = 'button',
    children,
    ...restProps
  }: HTMLButtonAttributes & { variant?: 'default' | 'outline' } = $props();
</script>

<button
  data-slot="button"
  class={[
    'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
    variant === 'outline'
      ? 'border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80 aria-pressed:hover:text-primary-foreground'
      : 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
    className,
  ]}
  {type}
  {...restProps}
>
  {@render children?.()}
</button>
