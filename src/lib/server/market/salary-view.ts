import { Option } from "effect";
import type { SalaryFacts } from "../../contracts/salary.ts";
import { isoEpochMillis, parseIsoTime } from "../../contracts/iso-time.ts";

export type SalaryRow = Pick<SalaryFacts, "form" | "min_nok" | "max_nok" | "period" | "period_inferred" | "sko_code" | "ltr_min" | "ltr_max"> & {
  readonly uuid: string; readonly title: string | null; readonly employer: string | null;
  readonly detail_changed: string; readonly closed: boolean;
};

export type SalaryAd = {
  uuid: string; title: string | null; employer: string | null; month: string; changed: string;
  form: SalaryFacts["form"]; low: number | null; high: number | null; period: SalaryFacts["period"];
  period_inferred: boolean; sko_code: string | null; ltr_min: number | null; ltr_max: number | null;
  yearly: number | null; sko_or_vague: boolean; closed: boolean;
};

export type SalaryAds = { ads: readonly SalaryAd[]; undated: number };

export type SalaryMonth = { month: string; facts: number; numeric: number; median_yearly: number | null; sko_or_vague: number };

export type SalaryTrend = { months: SalaryMonth[]; undated: number };

export type YearlyStats = { count: number; minimum: number | null; p25: number | null; median: number | null; p75: number | null; maximum: number | null };

const nbsp = "\u00a0";
const units = { year: "kr/år", month: "kr/mnd", hour: "kr/time" } as const;
const factors = { year: 1, month: 12, hour: 1950 } as const;

export const formatNok = (value: number): string => {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const cents = scaled - floor === 0.5 ? floor + (floor % 2 === 0 ? 0 : 1) : Math.round(scaled);
  const whole = Math.floor(cents / 100);
  const fraction = cents - whole * 100;
  const digits = whole.toLocaleString("en-US").replaceAll(",", nbsp);

  return fraction === 0 ? digits : `${digits},${String(fraction).padStart(2, "0")}`;
};

export const displayLabel = (facts: SalaryFacts | null, textRead: boolean): string => {
  if (facts === null || (facts.form === null && facts.sko_code === null && facts.ltr_min === null && !facts.amount_unclear)) {
    return textRead ? "Lønn ikke oppgitt" : "Lønn ukjent";
  }

  const parts: string[] = [];
  let figure = "";

  if (facts.form === "max" && facts.max_nok !== null) figure = `inntil ${formatNok(facts.max_nok)}`;
  else if ((facts.form === "range" || facts.form === "single") && facts.min_nok !== null) {
    const high = facts.max_nok || facts.min_nok;
    const low = Math.min(facts.min_nok, high);
    const top = Math.max(facts.min_nok, high);
    figure = formatNok(low) + (top === low ? "" : `–${formatNok(top)}`);
  }

  if (facts.form === "vague") parts.push("Lønn: uten beløp");
  else if (figure) {
    const unit = facts.period === null ? "kr (periode ikke oppgitt)"
      : facts.period === "year" && facts.period_inferred ? "kr (trolig årslønn)" : units[facts.period];

    parts.push(`Lønn: ${figure}${nbsp}${unit}`);
  } else if (facts.form !== null || facts.amount_unclear) parts.push("Lønn: beløp ukjent");

  if (facts.sko_code !== null) parts.push(`SKO ${facts.sko_code}`);

  if (facts.ltr_min !== null) parts.push(`Lønnstrinn ${facts.ltr_min}${facts.ltr_max !== null && facts.ltr_max !== facts.ltr_min ? `–${facts.ltr_max}` : ""}`);

  return parts.join(" · ");
};

export const readSalaryRows = (rows: readonly SalaryRow[], listingIds?: ReadonlySet<string>): SalaryAds => {
  const ads: SalaryAd[] = [];
  let undated = 0;

  for (const row of rows) {
    if (listingIds !== undefined && !listingIds.has(row.uuid)) continue;

    if (row.form === null && row.sko_code === null && row.ltr_min === null) continue;
    const parsed = parseIsoTime(row.detail_changed);

    if (Option.isNone(parsed) || !parsed.value.aware) { undated++; continue; }

    const date = new Date(isoEpochMillis(parsed.value));

    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) { undated++; continue; }

    const stamp = date.toISOString();

    const yearly = (row.form === "range" || row.form === "single") && row.min_nok !== null && row.period !== null
      ? (row.min_nok + (row.max_nok ?? row.min_nok)) / 2 * factors[row.period] : null;

    ads.push({ uuid: row.uuid, title: row.title, employer: row.employer, month: stamp.slice(0, 7), changed: `${stamp.slice(0, 10)} ${stamp.slice(11, 16)}`,
      form: row.form, low: row.min_nok, high: row.max_nok, period: row.period, period_inferred: row.period_inferred,
      sko_code: row.sko_code, ltr_min: row.ltr_min, ltr_max: row.ltr_max, yearly,
      sko_or_vague: yearly === null && (row.form === "vague" || (row.form === null && (row.sko_code !== null || row.ltr_min !== null))), closed: row.closed });
  }

  return { ads, undated };
};

const plausible = (value: number | null): boolean => value !== null && value >= 150_000 && value <= 3_000_000;

const quantile = (ordered: readonly number[], fraction: number): number => {
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const weight = position - lower;

  return (ordered[lower] ?? 0) * (1 - weight) + (ordered[Math.ceil(position)] ?? 0) * weight;
};

export const yearlyStats = (values: readonly number[]): YearlyStats => {
  const ordered = [...values].sort((a, b) => a - b);

  if (ordered.length < 5) return { count: ordered.length, minimum: null, p25: null, median: null, p75: null, maximum: null };

  return { count: ordered.length, minimum: ordered[0] ?? null, p25: quantile(ordered, 0.25), median: quantile(ordered, 0.5), p75: quantile(ordered, 0.75), maximum: ordered.at(-1) ?? null };
};

export const monthlyTrend = (salary: SalaryAds): SalaryTrend => {
  const buckets = new Map<string, { facts: number; values: number[]; vague: number }>();

  for (const ad of salary.ads) {
    const bucket = buckets.get(ad.month) ?? { facts: 0, values: [], vague: 0 };
    bucket.facts++;

    if (ad.yearly !== null && plausible(ad.yearly)) bucket.values.push(ad.yearly);
    else if (ad.sko_or_vague) bucket.vague++;
    buckets.set(ad.month, bucket);
  }

  const months = [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([month, bucket]) => ({ month, facts: bucket.facts, numeric: bucket.values.length, median_yearly: yearlyStats(bucket.values).median, sko_or_vague: bucket.vague }));

  return { months, undated: salary.undated };
};

export const salarySection = (salary: SalaryAds) => ({
  ads: [...salary.ads].sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0).map(({ uuid, yearly, ...ad }) => ({ ...ad, job_id: uuid, yearly_midpoint: yearly, outside_plausible_range: yearly !== null && !plausible(yearly) })),
  monthly: monthlyTrend(salary).months,
  undated: salary.undated,
});
