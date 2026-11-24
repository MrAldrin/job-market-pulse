<script lang="ts">
  import AboutData from '../components/AboutData.svelte';
  import BoxedDisclosure from '../components/BoxedDisclosure.svelte';
  import DataTable from '../components/DataTable.svelte';
  import ReadingChart from '../components/ReadingChart.svelte';
  import { frozenReadings, historyReadings, latestMarketRecording, projectMarket, reviewedReadings } from '../dashboard/market-view';
  import { isMonthLabel, isoWeekStart } from '../dashboard/period-adjacency';
  import { projectReadingChart } from '../dashboard/reading-chart';
  import { Option } from 'effect';
  import { isoEpochMillis, parseIsoTime } from '../contracts/iso-time';
  import type { MarketRecording } from '../contracts/pipeline-progress';
  import type { Snapshot } from '../snapshot';

  let { snapshot, marketRecording }: { snapshot: Snapshot; marketRecording?: MarketRecording | undefined } = $props();

  const market = $derived(projectMarket(snapshot));
  const latest = $derived(latestMarketRecording(snapshot, marketRecording));
  const recordingTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Oslo' });

  const recordingSummary = $derived.by(() => {
    const parsed = latest && parseIsoTime(latest.captured_at);

    if (!latest || !parsed || Option.isNone(parsed)) return 'Recording time and run ID not available.';
    const date = recordingTime.format(isoEpochMillis(parsed.value));
    const source = latest.run_id ? `Recorded by local refresh. Run ID: ${latest.run_id}` : 'Run ID not saved.';

    return `${date} (Oslo time). ${source}`;
  });

  type Cadence = 'monthly' | 'weekly';

  type History = Parameters<typeof historyReadings>[0];

  type Series =
    | { label: string; kind: 'archive'; cadence: Cadence; data: Parameters<typeof frozenReadings>[0] }
    | { label: string; kind: 'history'; cadence: Cadence | 'other'; data: History }
    | { label: string; kind: 'reviewed'; cadence: Cadence; data: Parameters<typeof reviewedReadings>[0] };

  type Metric = { label: string; value: Parameters<typeof frozenReadings>[2] };

  const cadences: readonly Cadence[] = ['monthly', 'weekly'];

  const historyGroups = {
    frozenTitles: 'Additional archived NAV sample, titles only',
    frozenTitlesAndText: 'Archived NAV sample, titles and text',
    recordedTitles: 'Recorded tracked stock, titles only',
    recordedDetailed: 'Recorded owner-filtered stock, detail',
  } as const;

  const periods = { monthly: 'monthly', weekly: 'weekly', other: 'unrecognized periods (table only)' };

  const series = $derived.by(() => {
    const saved: Series[] = [];

    for (const cadence of cadences) {
      const archive = market.frozen?.[cadence];

      if (archive?.periods.length) saved.push({ label: `Archived NAV sample, titles only, ${cadence}`, kind: 'archive', cadence, data: archive });
    }

    if (market.history) {
      const { frozenTitles, frozenTitlesAndText, recordedTitles, recordedDetailed } = market.history;

      const add = (label: string, group: { monthly?: History; weekly: History; other: History }) => {
        for (const period of ['monthly', 'weekly', 'other'] as const) {
          const data = group[period];

          if (data?.length) saved.push({ label: `${label}, ${periods[period]}`, kind: 'history', cadence: period, data });
        }
      };

      add(historyGroups.frozenTitles, frozenTitles);
      add(historyGroups.frozenTitlesAndText, frozenTitlesAndText);
      add(historyGroups.recordedTitles, recordedTitles);
      add(historyGroups.recordedDetailed, recordedDetailed);
    }

    if (market.reviewedFirstSeen) {
      for (const cadence of cadences) {
        if (market.reviewedFirstSeen[cadence].length) saved.push({ label: `Retained reviewed jobs by first-seen date, ${cadence}`, kind: 'reviewed', cadence, data: market.reviewedFirstSeen });
      }
    }

    return saved;
  });

  let seriesLabel = $state('');
  let metricIndex = $state(0);
  const selected = $derived(series.find((entry) => entry.label === seriesLabel) ?? series[0]);

  const metrics = $derived.by((): Metric[] => {
    if (!selected) return [];

    const options: Metric[] = [{ label: 'Job count', value: { kind: 'ad_count' } }];

    if (selected.kind === 'archive') {
      options.push({ label: 'Tech/data job count', value: { kind: 'tech_total' } });

      for (const { key, label } of selected.data.families) options.push({ label: `Role family: ${label}`, value: { kind: 'families', key } });

      for (const { key, label } of selected.data.terms) {
        options.push({ label: `Term: ${label} (all jobs)`, value: { kind: 'terms', key } });
        options.push({ label: `Term: ${label} (tech/data jobs)`, value: { kind: 'tech_terms', key } });
      }
    } else if (selected.kind === 'history') {
      const aggregates = { families: 'Role family', terms: 'Term in all jobs', tech_terms: 'Term in tech/data jobs' } as const;

      for (const kind of ['families', 'terms', 'tech_terms'] as const) {
        const keys = new Set<string>();

        for (const { counts } of selected.data) for (const key of Object.keys(counts[kind])) keys.add(key);

        for (const key of [...keys].sort()) options.push({ label: `${aggregates[kind]}: ${key}`, value: { kind, key } });
      }
    }

    return options;
  });

  const metric = $derived(metrics[metricIndex] ?? metrics[0]);
  const frozen = $derived(selected?.kind === 'archive' && metric ? frozenReadings(selected.data, selected.cadence, metric.value) : []);

  const history = $derived(selected?.kind === 'history' && metric
    ? historyReadings(selected.data, 'key' in metric.value ? metric.value : 'ad_count') : []);

  const reviewed = $derived(selected?.kind === 'reviewed' ? reviewedReadings(selected.data, selected.cadence) : []);

  const chart = $derived.by(() => {
    if (!selected) return null;

    if (selected.kind === 'archive') return projectReadingChart(frozen, selected.cadence, (period) => period.label);

    if (selected.kind === 'history') return projectReadingChart(history, selected.cadence,
      ({ period }) => period.label, ({ period, capture }) => capture?.capture_week ?? period.label);

    return projectReadingChart(reviewed, selected.cadence, (period) => period.label, ({ label, start }) => {
      const time = selected.cadence === 'monthly' ? Date.parse(`${label}-01T00:00:00Z`) : isoWeekStart(label);

      return time === Date.parse(`${start}T00:00:00Z`) ? label : '';
    });
  });

  const recognized = (label: string) => selected?.kind === 'archive' && selected.cadence === 'monthly'
    ? isMonthLabel(label) : isoWeekStart(label) !== null;

  const missing = 'Not recorded';

  const latestReading = $derived(chart?.points.reduce<(typeof chart.points)[number] | undefined>(
    (last, point) => last === undefined || point.time >= last.time ? point : last, undefined));

  const calendarGaps = $derived.by(() => {
    if (!chart || !selected || selected.cadence === 'other') return [];
    const first = chart.ticks[0], last = chart.ticks.at(-1);

    if (first === undefined || last === undefined) return [];
    const weekly = selected.cadence === 'weekly';
    const week = 7 * 86_400_000;

    const ordinal = (time: number) => {
      const date = new Date(time);

      return weekly ? (time - first) / week : date.getUTCFullYear() * 12 + date.getUTCMonth();
    };

    const label = (index: number) => weekly ? new Date(first + index * week).toISOString().slice(0, 10)
      : `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;

    const gaps: string[] = [];
    let next = ordinal(first);

    for (const index of [...new Set([...chart.points.map((point) => ordinal(point.time)), ordinal(last) + 1])].sort((a, b) => a - b)) {
      if (index > next) gaps.push(index === next + 1 ? label(next) : `${label(next)} to ${label(index - 1)}`);
      next = index + 1;
    }

    return gaps;
  });

  const coverage = { missing: 'Missing period', partial: 'Partial period', unverified: 'Unverified period', closed: 'Calendar period ended' };
  const sampleLabel = (sampled: boolean | null) => sampled === null ? missing : sampled ? 'Marked sampled' : 'Not marked sampled';

  const periodColumns = [
    { key: 'label', label: 'Period' }, { key: 'value', label: 'Count', numeric: true },
    { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
    { key: 'taxonomy', label: 'Taxonomy version' }, { key: 'captured', label: 'Captured at' },
    { key: 'sample', label: 'Sample flag' },
  ];

  const frozenRows = $derived(frozen.map(({ period, value }) => ({
    label: period.label, value: value ?? missing, start: period.start ?? missing, end: period.end ?? missing,
    taxonomy: period.taxonomy_version ?? missing, captured: period.captured_at ?? missing,
    sample: sampleLabel(period.sampled), coverage: coverage[period.coverage],
  })));

  const calendarRows = $derived(frozenRows.filter((row) => recognized(row.label)));
  const otherRows = $derived(frozenRows.filter((row) => !recognized(row.label)));

  const historyRows = $derived(history.map(({ period: { period, capture }, value }) => ({
    label: period.label, value: value ?? missing, start: period.period_start ?? missing, end: period.period_end ?? missing,
    taxonomy: period.taxonomy_version, captured: period.captured_at, sample: sampleLabel(period.sampled),
    text: capture ? `${capture.textCoverage.covered}/${capture.textCoverage.population}` : missing,
    occupation: capture ? `${capture.occupationCoverage.covered}/${capture.occupationCoverage.population}` : missing,
  })));
</script>

<div class="space-y-5">
  <h1 class="text-2xl font-semibold">Market</h1>

  {#if selected && metric}
    <div class="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <section class="min-w-0 space-y-3" aria-label="Market reading">
        <div class="space-y-1 rounded-lg border bg-card p-4">
          <h2 class="font-semibold [overflow-wrap:anywhere]">{selected.label}</h2>
          <p class="text-sm">{metric.label} · {latestReading ? `Latest saved period: ${latestReading.label}` : 'No saved calendar reading'}</p>
          <p class="text-2xl font-semibold tabular-nums">{latestReading ? `${latestReading.value} jobs` : missing}</p>
        </div>
        {#if chart}
          {#key `${selected.label}: ${metric.label}`}
            <ReadingChart title={`${selected.label}: ${metric.label}`} unit="jobs" readings={chart} />
          {/key}
        {/if}
        {#if calendarGaps.length}
          <p class="text-sm"><strong>Not recorded</strong> ({selected.cadence === 'weekly' ? 'weeks starting' : 'months'}): {calendarGaps.join('; ')}</p>
        {/if}
      </section>
      <section class="grid min-w-0 content-start gap-3 rounded-lg border bg-card p-4" aria-label="Market controls">
        <h2 class="font-semibold">Choose a reading</h2>
      <label class="grid min-w-0 gap-1">
        History series
        <select class="w-full min-w-0 rounded-md border bg-background p-2" value={selected.label}
          onchange={(event) => { seriesLabel = event.currentTarget.value; metricIndex = 0; }}>
          {#each series as entry (entry.label)}<option value={entry.label}>{entry.label}</option>{/each}
        </select>
      </label>
      {#if metrics.length > 1}
        <label class="grid min-w-0 gap-1">
          Count to show
          <select class="w-full min-w-0 rounded-md border bg-background p-2" bind:value={metricIndex}>
            {#each metrics as option, index (index)}<option value={index}>{option.label}</option>{/each}
          </select>
        </label>
      {/if}
      </section>
    </div>
    <BoxedDisclosure open>
      {#snippet summary()}Show values{/snippet}
      <div class="space-y-3">
      {#if selected.kind === 'archive'}
        {@const columns = [...periodColumns, { key: 'coverage', label: 'Period coverage' }]}
        {#if calendarRows.length}<DataTable {columns} rows={calendarRows} caption={`${selected.label}: ${metric.label}`} />{/if}
        {#if otherRows.length}<DataTable {columns} rows={otherRows} caption={`${selected.label}: ${metric.label} (unrecognized periods, table only)`} />{/if}
      {:else if selected.kind === 'history'}
        {@const columns = history[0]?.period.capture ? [...periodColumns,
          { key: 'text', label: 'Full-text coverage (X/Y)' }, { key: 'occupation', label: 'Occupation coverage (K/Y)' }] : periodColumns}
        <DataTable {columns} rows={historyRows} caption={`${selected.label}: ${metric.label}`} />
      {:else}
        <DataTable columns={[{ key: 'label', label: 'Period' }, { key: 'start', label: 'Start' }, { key: 'value', label: 'Count', numeric: true }]}
          rows={reviewed.map(({ period, value }) => ({ label: period.label, start: period.start, value: value ?? missing }))}
          caption={selected.label} />
      {/if}
      </div>
    </BoxedDisclosure>
  {/if}

  {#if !market.frozen}
    <p>Base archived NAV sample trends unavailable.</p>
  {:else}
    {#if market.frozen.monthly.periods.length === 0}<p>No monthly history in the base archived NAV sample.</p>{/if}
    {#if market.frozen.weekly === null}<p>Weekly series unavailable in the base archived NAV sample.</p>
    {:else if market.frozen.weekly.periods.length === 0}<p>No weekly history in the base archived NAV sample.</p>{/if}
  {/if}
  {#if market.history === null}
    <p>Recorded stock history unavailable.</p>
  {:else}
    {#if !market.history.recordedTitles.weekly.length && !market.history.recordedTitles.other.length}<p>No recorded tracked stock history.</p>{/if}
    {#if !market.history.recordedDetailed.weekly.length && !market.history.recordedDetailed.other.length}<p>No recorded owner-filtered stock history.</p>{/if}
  {/if}
  {#if !market.reviewedFirstSeen}
    <p>Reviewed-job first-seen trends unavailable.</p>
  {:else}
    {#if !market.reviewedFirstSeen.monthly.length}<p>No monthly reviewed-job first-seen counts.</p>{/if}
    {#if !market.reviewedFirstSeen.weekly.length}<p>No weekly reviewed-job first-seen counts.</p>{/if}
  {/if}

  <AboutData items={[
    { title: 'Last Market recording', text: recordingSummary },
    { title: 'Archived NAV sample', text: 'These are retained NAV sample counts, not national totals or personal fit. Not marked sampled does not mean full coverage.' },
    { title: 'Periods and taxonomy', text: 'Missing readings are not zero. Missing periods and taxonomy changes break lines. Lines connect only saved readings, not continuous counts. An ended calendar period does not prove complete collection. Compare classifications only within the same taxonomy version and basis.' },
    { title: 'Recorded stock', text: 'These Oslo-week recordings count unexpired stock at capture time. They do not count jobs by publication week or confirm current openings. Tracked stock uses titles only. Detailed stock uses jobs admitted by the owner’s filters before AI review. It can fall back to titles.' },
    { title: 'Coverage', text: 'Y is the captured population. X counts jobs with current-version full text. K counts jobs with current-version occupation evidence.' },
    { title: 'Retained reviewed jobs', text: 'Counts use first-seen dates for reviewed jobs still in the saved source data. Jobs past their saved expiry are excluded. Earlier counts can change when jobs expire or leave the saved source data. These are not recommendations or national counts.' },
    { title: 'Saved data', text: 'This page does not refresh the source.' },
  ]} />
</div>
