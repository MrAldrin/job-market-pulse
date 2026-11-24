import { isMonthLabel, isoWeekStart } from "./period-adjacency.ts";

type Cadence = "monthly" | "weekly" | "other";

type Reading<Period> = {
  readonly period: Period;
  readonly value: number | null;
  readonly connectsToPrevious: boolean;
};

type ChartPoint = { label: string; time: number; value: number; segment: number };

export const projectReadingChart = <Period>(readings: readonly Reading<Period>[], cadence: Cadence,
  labelOf: (period: Period) => string, calendarLabelOf = labelOf) => {
  const points: ChartPoint[] = [];
  const lines: ChartPoint[] = [];
  let first: number | undefined;
  let last: number | undefined;
  let previous: ChartPoint | undefined;
  let previousJoined = false;

  for (const { period, value, connectsToPrevious } of readings) {
    const calendarLabel = calendarLabelOf(period);

    const time = cadence === "weekly" ? isoWeekStart(calendarLabel)
      : cadence === "monthly" && isMonthLabel(calendarLabel) ? Date.parse(`${calendarLabel}-01T00:00:00Z`) : null;

    if (time !== null) {
      first = first === undefined ? time : Math.min(first, time);
      last = last === undefined ? time : Math.max(last, time);
    }

    if (time === null || value === null) {
      previous = undefined;
      previousJoined = false;
      continue;
    }

    const prior = connectsToPrevious ? previous : undefined;
    const point = { label: labelOf(period), time, value, segment: prior?.segment ?? points.length };

    if (prior) {
      if (!previousJoined) lines.push(prior);
      lines.push(point);
    }

    points.push(point);
    previous = point;
    previousJoined = prior !== undefined;
  }

  const ticks = first === undefined || last === undefined ? [] : first === last ? [first] : [first, last];

  return { points, lines, ticks };
};
