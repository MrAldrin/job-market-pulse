import { Option } from "effect";
import { isoEpochMillis, parseIsoDate, parseIsoTime } from "../../contracts/iso-time.ts";
import type { SnapshotInfo } from "../../contracts/market.ts";

export type TrendKind = "month" | "week";

export type Coverage = "partial" | "unverified" | "closed";

export const dayMillis = 86_400_000;

export const dayText = (millis: number): string => new Date(millis).toISOString().slice(0, 10);

export const periodBounds = (kind: TrendKind, label: string): readonly [string, string] | null => {
  if (kind === "month" && /^\d{4}-\d{2}$/.test(label)) {
    const start = parseIsoDate(`${label}-01`);

    if (Option.isNone(start)) return null;
    const next = new Date(start.value.millis);
    next.setUTCMonth(next.getUTCMonth() + 1);

    return [start.value.text, dayText(next.getTime() - dayMillis)];
  }

  if (kind === "week" && /^week-\d{4}-W\d{2}$/.test(label)) {
    const start = parseIsoDate(label.slice(5));

    return Option.isNone(start) ? null : [start.value.text, dayText(start.value.millis + 6 * dayMillis)];
  }

  return null;
};

export const periodLabel = (kind: TrendKind, day: string): string => {
  if (kind === "month") return day.slice(0, 7);
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 3 - (date.getUTCDay() + 6) % 7);
  const year = date.getUTCFullYear();
  const first = new Date(0);
  first.setUTCFullYear(year, 0, 4);
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(first.getUTCDate() + 3 - (first.getUTCDay() + 6) % 7);
  const week = 1 + Math.round((date.getTime() - first.getTime()) / (7 * dayMillis));

  return `week-${year}-W${String(week).padStart(2, "0")}`;
};

export const captureDate = (stamp: string): string | null => {
  const parsed = parseIsoTime(stamp);

  return Option.isSome(parsed) && parsed.value.aware ? dayText(isoEpochMillis(parsed.value)) : null;
};

export const periodCoverage = (info: SnapshotInfo, bounds: readonly [string, string], today: string): Coverage => {
  if (info.sampled || bounds[1] >= today) return "partial";
  const captured = captureDate(info.created_at);

  if (captured === null) return "unverified";

  if (captured <= bounds[1]) return "partial";

  return info.period_start === bounds[0] && info.period_end === bounds[1] ? "closed" : "unverified";
};

export const nextPeriod = (bounds: readonly [string, string]): string => dayText(Date.parse(`${bounds[1]}T00:00:00Z`) + dayMillis);

const osloDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });

// Capture week is not an ad's publication week or first-seen week.
export const captureWeek = (millis: number): string => periodLabel("week", osloDay.format(millis));
