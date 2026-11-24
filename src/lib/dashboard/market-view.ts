import { Option } from "effect";
import { parseIsoTime } from "../contracts/iso-time.ts";
import type { MarketRecording } from "../contracts/pipeline-progress.ts";
import type { SnapshotDocument, SnapshotV2 } from "../contracts/snapshot.ts";
import { consecutiveIsoWeeks, consecutiveMonths, daysBetween, isMonthLabel, isoWeekStart } from "./period-adjacency.ts";

type FrozenMarket = NonNullable<SnapshotDocument["market"]>;

type FrozenSeries = FrozenMarket["monthly"];

type ReviewedTrend = NonNullable<SnapshotDocument["reviewed_trend"]>;

type HistoryPoint = NonNullable<SnapshotV2["market_history"]>[number];

type Capture = NonNullable<HistoryPoint["metadata"]>;

type Cadence = "monthly" | "weekly";

type Aggregate = "families" | "terms" | "tech_terms";

type AggregateMetric = { readonly kind: Aggregate; readonly key: string };

type FrozenMetric = { readonly kind: "ad_count" | "tech_total" } | AggregateMetric;

// The chart and exact-value table use the same readings. False starts a new line segment.
type Reading<Period> = {
  readonly period: Period;
  readonly value: number | null;
  readonly connectsToPrevious: boolean;
};

const readings = <Period>(periods: readonly Period[], valueAt: (period: Period, index: number) => number | null,
  adjacent: (previous: Period, current: Period) => boolean): readonly Reading<Period>[] => {
  let previous: Reading<Period> | undefined;

  return periods.map((period, index) => {
    const value = valueAt(period, index);

    const reading: Reading<Period> = {
      period, value,
      connectsToPrevious: previous !== undefined && previous.value !== null && value !== null && adjacent(previous.period, period),
    };

    previous = reading;

    return reading;
  });
};

// Project one selected metric, not a chart row for every family or term and period.
export const frozenReadings = (series: FrozenSeries, cadence: Cadence, metric: FrozenMetric) => {
  const counts = "key" in metric
    ? metric.kind === "families"
      ? series.families.find((family) => family.key === metric.key)?.counts
      : series.terms.find((term) => term.key === metric.key)?.[metric.kind === "terms" ? "counts" : "tech_counts"]
    : undefined;

  return readings(series.periods, (period, index) => "key" in metric ? counts?.[index] ?? null : period[metric.kind],
    (previous, current) => previous.taxonomy_version !== null && previous.taxonomy_version === current.taxonomy_version
      && (cadence === "monthly" ? consecutiveMonths(previous.label, current.label)
        : consecutiveIsoWeeks(previous.label, current.label)));
};

export const reviewedReadings = (trend: ReviewedTrend, cadence: Cadence) =>
  readings(trend[cadence], (period) => period.count, (previous, current) => cadence === "monthly"
    ? consecutiveMonths(previous.start.slice(0, 7), current.start.slice(0, 7)) : daysBetween(previous.start, current.start) === 7);

type CaptureProvenance = Pick<Capture, "series" | "capture_week" | "timezone" | "membership" | "classifier_engine">
  & { readonly textCoverage: CoverageRatio; readonly occupationCoverage: CoverageRatio };

type CoverageRatio = { readonly covered: number; readonly population: number };

type HistoryPeriod = Omit<HistoryPoint, "metadata" | "counts" | "origin">;

type ObservationValues = { readonly period: HistoryPeriod; readonly counts: HistoryPoint["counts"] };

type RecordedObservation = ObservationValues & { readonly origin: "recorded"; readonly capture: CaptureProvenance };

type FrozenObservation = ObservationValues & { readonly origin: "frozen_history"; readonly capture: null };

type HistoryObservation = FrozenObservation | RecordedObservation;

const observation = (point: HistoryPoint): HistoryObservation => {
  const { counts, metadata, origin, ...period } = point;
  const saved = { period, counts };

  if (origin === "frozen_history" || metadata === null) return { ...saved, origin: "frozen_history", capture: null };

  const { series, capture_week, timezone, membership, classifier_engine, population, text_coverage, occupation_coverage } = metadata;

  return { ...saved, origin: "recorded", capture: {
    series, capture_week, timezone, membership, classifier_engine,
    textCoverage: { covered: text_coverage, population },
    occupationCoverage: { covered: occupation_coverage, population },
  } };
};

export const historyReadings = (observations: readonly HistoryObservation[], metric: AggregateMetric | "ad_count") =>
  readings(observations, ({ period, counts }) => {
    if (metric === "ad_count") return period.ad_count;
    const values = counts[metric.kind];

    return Object.hasOwn(values, metric.key) ? values[metric.key] ?? null : null;
  }, (previous, current) => {
    const a = previous.period, b = current.period;

    if (previous.origin !== current.origin || a.basis !== b.basis || a.taxonomy_version !== b.taxonomy_version) return false;

    if (previous.capture && current.capture) return previous.capture.membership === current.capture.membership
      && previous.capture.classifier_engine === current.capture.classifier_engine
      && consecutiveIsoWeeks(previous.capture.capture_week, current.capture.capture_week);

    return consecutiveMonths(a.label, b.label) || consecutiveIsoWeeks(a.label, b.label);
  });

type LegacyPeriod = { readonly series: FrozenSeries; readonly index: number };

const sameCounts = <Row extends { readonly key: string }>(saved: HistoryPoint["counts"][Aggregate], rows: readonly Row[], index: number,
  values: (row: Row) => readonly (number | null)[]): boolean => {
  let present = 0;

  for (const row of rows) {
    const count = values(row)[index];

    if (count === null || count === undefined) continue;

    if (!Object.hasOwn(saved, row.key) || saved[row.key] !== count) return false;
    present++;
  }

  return present === Object.keys(saved).length;
};

const sameFrozenTitles = (point: HistoryPoint, { series, index }: LegacyPeriod): boolean => {
  const saved = series.periods[index];

  if (!saved || point.origin !== "frozen_history" || point.basis !== "titles" || point.metadata !== null
    || saved.coverage === "missing" || saved.label !== point.label || saved.start !== point.period_start || saved.end !== point.period_end
    || saved.sampled !== point.sampled || saved.taxonomy_version !== point.taxonomy_version || saved.captured_at !== point.captured_at
    || saved.ad_count !== point.ad_count) return false;

  const { families, terms, tech_terms } = point.counts;
  // The legacy total is redundant only when it matches the producer's non-Other family sum.
  const techTotal = Object.entries(families).reduce((total, [key, count]) => key === "other" ? total : total + count, 0);

  return saved.tech_total === techTotal && sameCounts(families, series.families, index, (row) => row.counts)
    && sameCounts(terms, series.terms, index, (row) => row.counts)
    && sameCounts(tech_terms, series.terms, index, (row) => row.tech_counts);
};

const frozenGroups = (): Record<Cadence | "other", FrozenObservation[]> => ({ monthly: [], weekly: [], other: [] });

const recordedGroups = (): Record<"weekly" | "other", RecordedObservation[]> => ({ weekly: [], other: [] });

const legacyPeriods = (series: FrozenSeries | null | undefined): ReadonlyMap<string, LegacyPeriod> =>
  new Map(series?.periods.map((period, index) => [period.label, { series, index }]));

const byKey = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export const latestMarketRecording = (snapshot: SnapshotDocument, local?: MarketRecording) => {
  let latest: { captured_at: string; run_id: string | null } | undefined = local;

  if (snapshot.schema_version !== 2) return latest;
  let latestTime = latest ? parseIsoTime(latest.captured_at) : Option.none();

  for (const point of snapshot.market_history ?? []) {
    if (point.origin !== "recorded") continue;
    const time = parseIsoTime(point.captured_at);

    if (Option.isSome(time) && (Option.isNone(latestTime) || time.value.epochMicros > latestTime.value.epochMicros)) {
      latest = { captured_at: point.captured_at, run_id: null };
      latestTime = time;
    }
  }

  return latest;
};

export const projectMarket = (snapshot: SnapshotDocument) => {
  const frozen = snapshot.market;
  const reviewedFirstSeen = snapshot.reviewed_trend;
  const history = snapshot.schema_version === 2 ? snapshot.market_history : null;

  if (history === null) return { frozen, reviewedFirstSeen, history: null };

  // Only the same calendar series can stand in for an equivalent frozen observation.
  const legacy = { monthly: legacyPeriods(frozen?.monthly), weekly: legacyPeriods(frozen?.weekly) };

  const groups = { frozenTitles: frozenGroups(), frozenTitlesAndText: frozenGroups(),
    recordedTitles: recordedGroups(), recordedDetailed: recordedGroups() };

  for (const point of history) {
    const titles = point.basis === "titles";
    const row = observation(point);

    if (row.origin === "recorded") {
      const basis = titles ? groups.recordedTitles : groups.recordedDetailed;
      const cadence = isoWeekStart(row.capture.capture_week) === null ? "other" : "weekly";

      basis[cadence].push(row);
    } else {
      const cadence = isMonthLabel(point.label) ? "monthly" : isoWeekStart(point.label) !== null ? "weekly" : "other";
      const samePeriod = cadence === "other" ? undefined : legacy[cadence].get(point.label);

      if (samePeriod && sameFrozenTitles(point, samePeriod)) continue;
      const basis = titles ? groups.frozenTitles : groups.frozenTitlesAndText;

      basis[cadence].push(row);
    }
  }

  for (const frozen of [groups.frozenTitles, groups.frozenTitlesAndText]) {
    for (const rows of [frozen.monthly, frozen.weekly]) rows.sort((a, b) => byKey(a.period.label, b.period.label));
  }

  for (const series of [groups.recordedTitles, groups.recordedDetailed]) {
    series.weekly.sort((a, b) => byKey(a.capture.capture_week, b.capture.capture_week));
  }

  return { frozen, reviewedFirstSeen, history: groups };
};
