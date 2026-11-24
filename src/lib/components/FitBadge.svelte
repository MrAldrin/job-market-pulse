<script lang="ts">
  import { fitLabel } from '../format';
  import type { Fit } from '../snapshot';

  let { fit }: { fit: Fit } = $props();

  const colors: Record<Fit, string> = {
    exceptional: 'bg-signal-positive text-signal-positive-foreground',
    strong: 'bg-signal-positive text-signal-positive-foreground',
    possible: 'bg-signal-caution text-signal-caution-foreground',
    poor: 'bg-signal-neutral text-signal-neutral-foreground',
    unknown: 'bg-signal-neutral text-signal-neutral-foreground',
  };
</script>

<span
  class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium {colors[
    fit
  ]}"
>
  {fitLabel(fit)}
</span>
