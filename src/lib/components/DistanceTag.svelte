<script lang="ts">
  import type { Job } from '../snapshot';

  let { job, radius }: { job: Job; radius: number | null } = $props();
  const distance = $derived('distance_km' in job ? job.distance_km : null);

  const style = $derived(distance === null || radius === null
    ? 'bg-signal-neutral text-signal-neutral-foreground'
    : distance <= radius / 3 ? 'bg-signal-positive text-signal-positive-foreground'
    : distance <= 2 * radius / 3 ? 'bg-signal-caution text-signal-caution-foreground'
    : 'bg-signal-failure text-signal-failure-foreground');
</script>

<span class="rounded-full px-2.5 py-0.5 text-xs {style}">
  {distance === null ? 'Distance unknown' : `≈ ${distance.toFixed(1)} km`}
</span>
