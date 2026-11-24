<script lang="ts">
  import { Axis, Chart, Layer, Points, Spline } from 'layerchart';
  import { projectReadingChart } from '../dashboard/reading-chart';
  import type { projectSalary } from '../dashboard/salary-view';

  type Month = Extract<ReturnType<typeof projectSalary>, { monthly: unknown }>['monthly'][number];

  let { months }: { months: readonly Month[] } = $props();

  const id = $props.id();
  let selectedIndex = $state(0);
  let plotViewportWidth = $state(0);
  const selected = $derived(months[selectedIndex]);

  const chart = $derived(projectReadingChart(months.map((month) => ({
    period: month.month, value: month.median_yearly, connectsToPrevious: month.connectsToPrevious,
  })), 'monthly', (month) => month));

  const ranges = $derived(months.flatMap(({ month, stats }) => {
    if (!stats) return [];
    const time = Date.parse(`${month}-01T00:00:00Z`);

    return [stats.low, stats.high].map((value) => ({ time, value, month }));
  }));

  const means = $derived(months.flatMap(({ month, stats }) => stats
    ? [{ time: Date.parse(`${month}-01T00:00:00Z`), value: stats.mean }] : []));

  const yDomain = $derived([0, Math.max(1, ...chart.points.map(({ value }) => value), ...ranges.map(({ value }) => value))]);
  const selectedPoint = $derived(chart.points.find(({ label }) => label === selected?.month));
  const byMonth = $derived(new Map(months.map((month) => [month.month, month])));
  const monthTicks = $derived([...byMonth.keys()].map((month) => Date.parse(`${month}-01T00:00:00Z`)).sort((a, b) => a - b));

  // Reserve room between the closest labels without changing calendar spacing.
  const plotWidth = $derived.by(() => {
    let previous = monthTicks[0];
    let spacing = Infinity;

    for (const time of monthTicks.slice(1)) {
      if (previous !== undefined) spacing = Math.min(spacing, time - previous);
      previous = time;
    }

    return 96 + Math.ceil(82 * ((monthTicks.at(-1) ?? 0) - (monthTicks[0] ?? 0)) / spacing);
  });

  const scrolls = $derived(plotViewportWidth > 0 && plotViewportWidth < plotWidth);
  const formatMonth = (time: number) => new Date(time).toISOString().slice(0, 7);
  const formatPay = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
</script>

<figure class="min-w-0 space-y-3 rounded-lg border bg-card p-4" aria-labelledby={`${id}-title`} data-reading-chart>
  <figcaption id={`${id}-title`} class="font-semibold">Monthly pay (NOK/year)</figcaption>
  {#if chart.points.length}
    <p class="text-sm">Median: filled dot · Mean: ring · Observed low–high: vertical line · Selected median: dashed ring</p>
  {:else}
    <p>No monthly pay values to plot.</p>
  {/if}
  {#if monthTicks.length}
    {#if scrolls}<p class="text-sm text-muted-foreground" id={`${id}-scroll`}>Scroll for more months.</p>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the plot.) -->
    <div class="min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring" role="region" aria-label="Salary plot"
      aria-describedby={scrolls ? `${id}-scroll` : undefined} tabindex={scrolls ? 0 : undefined} bind:clientWidth={plotViewportWidth}>
      <div class="{chart.points.length ? 'h-56' : 'h-16'}" style:min-width={`${plotWidth}px`} aria-hidden="true" data-reading-plot>
        <Chart data={chart.points} x="time" y="value" xDomain={chart.ticks.length === 1 ? [chart.ticks[0], chart.ticks[0]] : chart.ticks} {yDomain}
          padding={{ left: 48, right: 48, top: 12, bottom: 48 }} tooltipContext={false} pointerEvents={false}>
          <Layer type="svg">
            <Axis placement="bottom" ticks={monthTicks} format={formatMonth}>
              {#snippet tickLabel({ props })}
                {@const period = String(props.value)}
                {@const month = byMonth.get(period)}
                {#if month && typeof props.x === 'number' && typeof props.y === 'number'}
                  <text data-salary-month={period} x={props.x} y={props.y} text-anchor="middle" fill="currentColor" font-size="12">
                    <tspan x={props.x} dy="14">{period}</tspan>
                    <tspan x={props.x} dy="14">n={month.numeric}</tspan>
                    {#if month.hidden}<tspan x={props.x} dy="14">Hidden</tspan>
                    {:else if month.median_yearly === null}<tspan x={props.x} dy="14">Not recorded</tspan>{/if}
                  </text>
                {/if}
              {/snippet}
            </Axis>
            {#if chart.points.length}
              <Axis placement="left" ticks={4} format="metric" grid />
              <Spline data={ranges} g="month" stroke="currentColor" strokeWidth={2} fill="none" class="text-muted-foreground" data-salary-range />
              <Points data={ranges} r={2} fill="currentColor" class="text-muted-foreground" />
              {#if chart.lines.length}
                <Spline data={chart.lines} g="segment" stroke="currentColor" strokeWidth={2} fill="none" class="text-primary" data-reading-line />
              {/if}
              <Points r={3} fill="currentColor" class="text-primary" data-reading-point />
              <Points data={means} r={6} fill="none" stroke="currentColor" strokeWidth={2} class="text-primary" data-salary-mean />
              {#if selectedPoint}
                <Points data={[selectedPoint]}>
                  {#snippet children({ points })}
                    {#each points as { x, y }}
                      <circle cx={x} cy={y} r="10" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-dasharray="3 2" class="text-primary" data-reading-selected />
                    {/each}
                  {/snippet}
                </Points>
              {/if}
            {/if}
          </Layer>
        </Chart>
      </div>
    </div>
  {/if}
  <label class="grid min-w-0 gap-1 text-sm" for={`${id}-period`}>
    Chart period
    <select id={`${id}-period`} class="w-full min-w-0 rounded-md border border-control bg-background p-2 focus-visible:outline-2 focus-visible:outline-ring"
      bind:value={selectedIndex}>
      {#each months as month, index (month.month)}
        <option value={index}>{month.month} · n={month.numeric}{month.hidden ? ' · Hidden' : month.median_yearly === null ? ' · Not recorded' : ''}</option>
      {/each}
    </select>
  </label>
  {#if selected}
    <output class="block text-sm tabular-nums" for={`${id}-period`} data-reading-value>
      {#if selected.hidden}Hidden: fewer than 5 eligible facts.
      {:else if selected.median_yearly === null}Not recorded.
      {:else}
        Median: {formatPay.format(selected.median_yearly)} NOK/year.
        {#if selected.stats}
          Mean: {formatPay.format(selected.stats.mean)}. Observed low–high: {formatPay.format(selected.stats.low)}–{formatPay.format(selected.stats.high)}.
        {:else}
          Mean and range: Not recorded.
        {/if}
      {/if}
    </output>
  {/if}
</figure>
