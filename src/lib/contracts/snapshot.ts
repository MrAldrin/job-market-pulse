import { Either, Option, Schema } from "effect";
import { parseIsoDate } from "./iso-time.ts";
import { awareTimestamp, boundedInteger, boundedText, decodeStrict, finiteNumber, header, integerToken } from "./support.ts";
import { parseStrictContractBytes } from "../server/shared/strict-contract-json.ts";
import { strip } from "../server/shared/text.ts";
import { MarketBasis, MarketCaptureMetadata } from "./market.ts";
import { FitLevel } from "./reviewer-settings.ts";
import { DisplayModelLabel, SnapshotPersonalInputs, SnapshotSettings, SnapshotSettingsV4 } from "./snapshot-settings.ts";

const text = boundedText();
const count = boundedInteger();
const nullable = Schema.NullOr;
const list = <A, I>(item: Schema.Schema<A, I>, max: number) => Schema.Array(item).pipe(Schema.maxItems(max));
const date = text.pipe(Schema.filter((value) => Option.exists(parseIsoDate(value), (parsed) => parsed.text === value)));
const month = text.pipe(Schema.filter((value) => Option.exists(parseIsoDate(value + "-01"), (parsed) => parsed.text === value + "-01")));

const changed = text.pipe(Schema.filter((value) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)
  && Option.exists(parseIsoDate(value.slice(0, 10)), (parsed) => parsed.text === value.slice(0, 10))
  && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60));

const reviewText = text.pipe(Schema.filter((value) => Array.from(strip(value)).length <= 1000));

export const SnapshotAssessment = Schema.Struct({
  fit: FitLevel, reason: reviewText,
  evidence: list(reviewText, 20), uncertainties: list(reviewText, 20),
  hard_constraints: Schema.Literal("pass", "fail", "unknown"), ad_text_reviewed: Schema.Boolean,
}).pipe(Schema.filter((a) => (!(a.fit === "strong" || a.fit === "exceptional") || (a.ad_text_reviewed && a.evidence.length > 0))
  && (a.fit !== "exceptional" || (a.hard_constraints === "pass" && a.uncertainties.length === 0))));

export const SnapshotRejudge = Schema.Struct({
  first_fit: FitLevel, first_model: nullable(DisplayModelLabel), model: nullable(DisplayModelLabel),
});

const job = Schema.Struct({
  id: text, source: text, source_version: text, title: text, employer: text, locations: list(text, 2000),
  url: text.pipe(Schema.filter((value) => value.startsWith("https://"))),
  expires_at: nullable(awareTimestamp), status: Schema.Literal("open", "closed"), first_found_at: nullable(awareTimestamp),
  reviewed_at: nullable(awareTimestamp), result_id: nullable(text), assessment: SnapshotAssessment,
});

const jobV4 = Schema.extend(job, Schema.Struct({ rejudge: Schema.optionalWith(SnapshotRejudge, { exact: true }) }));

const jobV6 = Schema.extend(jobV4, Schema.Struct({
  distance_km: nullable(Schema.Union(integerToken, finiteNumber).pipe(Schema.between(0, 21_000))),
}));

const period = Schema.Struct({
  label: text, start: nullable(date), end: nullable(date), partial: nullable(Schema.Boolean), ad_count: nullable(count),
  tech_total: nullable(count), sampled: nullable(Schema.Boolean), taxonomy_version: nullable(text),
  captured_at: nullable(awareTimestamp), coverage: Schema.Literal("partial", "unverified", "closed", "missing"),
}).pipe(Schema.filter((p) => p.coverage === "missing"
  ? p.start === null && p.end === null && p.partial === null && p.ad_count === null && p.tech_total === null && p.sampled === null && p.taxonomy_version === null && p.captured_at === null
  : p.ad_count !== null && p.tech_total !== null && p.sampled !== null && p.taxonomy_version !== null && p.captured_at !== null && p.partial === (p.coverage !== "closed")));

const family = Schema.Struct({ key: text, label: text, counts: list(nullable(count), 1200) });
const term = Schema.Struct({ key: text, group: text, label: text, counts: list(nullable(count), 1200), tech_counts: list(nullable(count), 1200) });
const unique = (values: readonly string[]) => new Set(values).size === values.length;

const series = Schema.Struct({ periods: list(period, 1200), families: list(family, 2000), terms: list(term, 2000) }).pipe(Schema.filter((s) => {
  const aligned = (counts: readonly (number | null)[]) => counts.length === s.periods.length && counts.every((v, i) => s.periods[i]?.coverage !== "missing" || v === null);

  return unique(s.periods.map((p) => p.label)) && unique(s.families.map((r) => r.key)) && unique(s.terms.map((r) => r.key))
    && s.families.every((r) => aligned(r.counts)) && s.terms.every((r) => aligned(r.counts) && aligned(r.tech_counts));
}));

const market = Schema.Struct({ taxonomy_version: text, captured_at: awareTimestamp, monthly: series, weekly: nullable(series), note: text });
const reviewedPeriod = Schema.Struct({ label: text, start: date, count });
const ordered = (values: readonly string[]) => values.every((value, i) => i === 0 || (values[i - 1] ?? "") < value);
const reviewedPeriods = list(reviewedPeriod, 1200).pipe(Schema.filter((rows) => unique(rows.map((r) => r.label)) && ordered(rows.map((r) => r.start))));
const reviewedTrend = Schema.Struct({ weekly: reviewedPeriods, monthly: reviewedPeriods });
const number = nullable(Schema.Union(integerToken, finiteNumber).pipe(Schema.between(0, 1_000_000_000_000)));

const salaryAd = Schema.Struct({
  job_id: text, title: nullable(text), employer: nullable(text), month, changed,
  form: nullable(Schema.Literal("range", "single", "max", "vague")), low: number, high: number,
  period: nullable(Schema.Literal("year", "month", "hour")), period_inferred: Schema.Boolean, sko_code: nullable(text),
  ltr_min: nullable(count), ltr_max: nullable(count), yearly_midpoint: number, sko_or_vague: Schema.Boolean,
  closed: Schema.Boolean, outside_plausible_range: Schema.Boolean,
});

const salaryMonth = Schema.Struct({ month, facts: count, numeric: count, median_yearly: number, sko_or_vague: count });

const salary = Schema.Struct({ ads: list(salaryAd, 2000), monthly: list(salaryMonth, 1200), undated: count })
  .pipe(Schema.filter((s) => unique(s.ads.map((a) => a.job_id)) && ordered(s.monthly.map((m) => m.month))));

const snapshotFields = {
  generated_at: awareTimestamp,
  profile: Schema.Struct({ id: text, mode: Schema.Literal("passive", "active") }),
  source: Schema.Struct({ name: text, checked_at: nullable(awareTimestamp), coverage_note: text }),
  counts: Schema.Struct({ eligible: count, reviewed: count, open: count, closed: count, pending: count, screened_out: count, failed: count }),
  jobs: list(job, 2000), shortlist: Schema.Struct({ job_ids: list(text, 2000), rule: text }),
  market: nullable(market), reviewed_trend: nullable(reviewedTrend), salary: nullable(salary),
};

const snapshotBase = Schema.Struct(snapshotFields);

const validReferences = (snapshot: typeof snapshotBase.Type) => {
  const jobs = new Map(snapshot.jobs.map((row) => [row.id, row]));

  return jobs.size === snapshot.jobs.length && snapshot.shortlist.job_ids.every((id) => jobs.get(id)?.status === "open")
    && (snapshot.salary === null || snapshot.salary.ads.every((ad) => jobs.has(ad.job_id)));
};

export const Snapshot = Schema.Struct({ ...header("pulse.snapshot", 1), ...snapshotFields }).pipe(Schema.filter(validReferences));

export type Snapshot = typeof Snapshot.Type;

export const decodeSnapshot = decodeStrict(Snapshot);

export const decodeSnapshotBytes = (bytes: Uint8Array) => Either.flatMap(parseStrictContractBytes(bytes, 8_000_000), decodeSnapshot);

// Payload v2 is explicit. It does not alter the legacy v1 export or physical store.
const captureMetadata = Schema.Struct({
  profile_id: text,
  series: MarketCaptureMetadata.fields.series,
  capture_week: text,
  timezone: MarketCaptureMetadata.fields.timezone,
  membership: MarketCaptureMetadata.fields.membership,
  classifier_engine: MarketCaptureMetadata.fields.classifier_engine,
  filter_fingerprint: MarketCaptureMetadata.fields.filter_fingerprint,
  population: count, text_coverage: count, occupation_coverage: count,
});

const aggregateCounts = Schema.Record({ key: text, value: count });

export const SnapshotMarketPoint = Schema.Struct({
  label: text, basis: MarketBasis, period_start: nullable(date), period_end: nullable(date),
  sampled: Schema.Boolean, ad_count: count, taxonomy_version: text, captured_at: awareTimestamp,
  counts: Schema.Struct({ families: aggregateCounts, terms: aggregateCounts, tech_terms: aggregateCounts }),
  origin: Schema.Literal("frozen_history", "recorded"), metadata: nullable(captureMetadata),
}).pipe(Schema.filter((point) => {
  const metadata = point.metadata;

  if (point.origin === "frozen_history") return metadata === null;

  if (metadata === null) return false;

  return metadata.population === point.ad_count && metadata.text_coverage <= metadata.population
    && metadata.occupation_coverage <= metadata.population
    && point.basis === (metadata.series === "titles" ? "titles" : "titles+text")
    && point.label === (metadata.series === "titles" ? metadata.capture_week : `detail-${metadata.capture_week}`);
}));

export const SnapshotV2 = Schema.Struct({
  ...header("pulse.snapshot", 2), ...snapshotFields,
  market_history: nullable(list(SnapshotMarketPoint, 2000)),
}).pipe(Schema.filter((snapshot) => validReferences(snapshot)
  && (snapshot.market_history === null || snapshot.market_history.every((point) => point.metadata === null || point.metadata.profile_id === snapshot.profile.id))));

export type SnapshotV2 = typeof SnapshotV2.Type;

export const SnapshotV3 = Schema.Struct({
  ...header("pulse.snapshot", 3), ...snapshotFields,
  settings: SnapshotSettings,
}).pipe(Schema.filter(validReferences));

export type SnapshotV3 = typeof SnapshotV3.Type;

export const SnapshotV4 = Schema.Struct({
  ...header("pulse.snapshot", 4), ...snapshotFields,
  jobs: list(jobV4, 2000), settings: SnapshotSettingsV4,
  personal_inputs: SnapshotPersonalInputs,
}).pipe(Schema.filter(validReferences));

export type SnapshotV4 = typeof SnapshotV4.Type;

export const RunFilters = Schema.Struct({ pool: count, area: count, exclusions: count, occupation: count, other: count });
const fitCounts = Schema.Struct({ exceptional: count, strong: count, possible: count, unknown: count, poor: count });

export const RunPool = Schema.Struct({
  filters: RunFilters,
  screen: Schema.Struct({ out: count, undecided: count, advanced: count }),
  judge: Schema.Struct({ unfinished: count, fits: fitCounts }),
  waiting: count, failed: count,
  listed_review_ids: list(text, 2000),
});

const runFitTotal = (fits: typeof fitCounts.Type): number =>
  fits.exceptional + fits.strong + fits.possible + fits.unknown + fits.poor;

const runFunnel = Schema.Struct({ nav_events: count, pool: nullable(RunPool) });

const validRun = (snapshot: typeof snapshotBase.Type & { readonly run_funnel: typeof runFunnel.Type | null }) => {
  const { counts, jobs, run_funnel } = snapshot;
  const pool = run_funnel?.pool ?? null;

  if (!validReferences(snapshot) || counts.reviewed !== jobs.length || counts.open !== jobs.filter((row) => row.status === "open").length
    || counts.closed !== counts.reviewed - counts.open) return false;

  if (pool === null) return true;
  const { filters, screen, judge, waiting, failed, listed_review_ids } = pool;
  const eligible = filters.pool - filters.area - filters.exclusions - filters.occupation - filters.other;

  if (eligible !== counts.eligible || eligible !== screen.out + screen.undecided + screen.advanced
    || screen.advanced !== judge.unfinished + runFitTotal(judge.fits) || waiting + failed > screen.undecided + judge.unfinished
    || !unique(listed_review_ids)) return false;

  const listed = new Set(listed_review_ids);
  const remaining = { ...judge.fits };

  for (const row of jobs) {
    if (!listed.delete(row.id)) continue;

    if (row.result_id === null || --remaining[row.assessment.fit] < 0) return false;
  }

  return listed.size === 0;
};

const personalFields = { settings: SnapshotSettingsV4, personal_inputs: SnapshotPersonalInputs };

export const SnapshotV5 = Schema.Struct({
  ...header("pulse.snapshot", 5), ...snapshotFields, ...personalFields,
  jobs: list(jobV4, 2000), run_funnel: runFunnel,
}).pipe(Schema.filter(validRun));

export type SnapshotV5 = typeof SnapshotV5.Type;

export const SnapshotV6 = Schema.Struct({
  ...header("pulse.snapshot", 6), ...snapshotFields, ...personalFields,
  jobs: list(jobV6, 2000), run_funnel: nullable(runFunnel),
}).pipe(Schema.filter(validRun));

export type SnapshotV6 = typeof SnapshotV6.Type;

export const SnapshotDocument = Schema.Union(Snapshot, SnapshotV2, SnapshotV3, SnapshotV4, SnapshotV5, SnapshotV6);

export type SnapshotDocument = typeof SnapshotDocument.Type;

export const decodeSnapshotDocument = decodeStrict(SnapshotDocument);
export const decodeSnapshotDocumentBytes = (bytes: Uint8Array) => Either.flatMap(parseStrictContractBytes(bytes, 8_000_000), decodeSnapshotDocument);
