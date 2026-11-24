<script lang="ts">
  import { Axis, Chart, Layer, Points, Spline } from 'layerchart';
  import type { projectReadingChart } from '../dashboard/reading-chart';

  let { title, unit, readings }: {
    title: string;
    unit: string;
    readings: ReturnType<typeof projectReadingChart>;
  } = $props();

  const id = $props.id();
  let selectedIndex = $state(0);
  const selected = $derived(readings.points[selectedIndex]);
  const yDomain = $derived([0, Math.max(3, ...readings.points.map((point) => point.value))]);
  const formatDate = (time: number) => new Date(time).toISOString().slice(0, 10);
</script>

<figure class="min-w-0 space-y-2 rounded-lg border p-3" aria-labelledby={`${id}-title`} data-reading-chart>
  <figcaption id={`${id}-title`} class="font-medium [overflow-wrap:anywhere]">{title}</figcaption>
  {#if readings.points.length}
    <div class="h-48 min-w-0" aria-hidden="true" data-reading-plot>
      <Chart data={readings.points} x="time" y="value" xDomain={readings.ticks.length === 1 ? [readings.ticks[0], readings.ticks[0]] : readings.ticks} {yDomain}
        padding={{ left: 42, right: 36, top: 10, bottom: 28 }} tooltipContext={false} pointerEvents={false}>
        <Layer type="svg">
          <Axis placement="left" ticks={3} format="metric" grid />
          <Axis placement="bottom" ticks={readings.ticks} format={formatDate} />
          {#if readings.lines.length}
            <Spline data={readings.lines} g="segment" stroke="currentColor" strokeWidth={2} fill="none" class="text-primary" data-reading-line />
          {/if}
          <Points r={3} fill="currentColor" class="text-primary" data-reading-point />
          {#if selected}
            <Points data={[selected]} r={5} fill="currentColor" class="text-primary" data-reading-selected />
          {/if}
        </Layer>
      </Chart>
    </div>
    <div class="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-end sm:gap-3">
      <label class="grid min-w-0 gap-1" for={`${id}-period`}>
        Chart period
        <select id={`${id}-period`} class="w-full min-w-0 rounded-md border bg-background p-2 focus-visible:outline-2 focus-visible:outline-ring"
          bind:value={selectedIndex}>
          {#each readings.points as point, index (index)}
            <option value={index}>{point.label}</option>
          {/each}
        </select>
      </label>
      <output class="pb-2 text-sm tabular-nums" for={`${id}-period`} data-reading-value>
        {#if selected}{selected.value} {unit}{/if}
      </output>
    </div>
  {:else}
    <p>No saved calendar values to plot. See Show values.</p>
  {/if}
</figure>
