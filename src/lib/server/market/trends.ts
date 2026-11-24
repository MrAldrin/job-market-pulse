import { Either, Option } from "effect";
import type { MarketAd, MarketBasis, SavedMarketSnapshot, SnapshotCounts, SnapshotInfo } from "../../contracts/market.ts";
import { parseIsoDate } from "../../contracts/iso-time.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { countSnapshot, techTotal, titlesOnly } from "./core.ts";
import type { Taxonomy } from "./taxonomy.ts";
import { MarketError } from "./errors.ts";
import { dayMillis, dayText, nextPeriod, periodBounds, periodCoverage, periodLabel, type TrendKind } from "./periods.ts";

const familyKeys = (tax: Taxonomy) => [...tax.families.map((family) => family.key), "other"];
const termKeys = (tax: Taxonomy) => tax.terms.map((term) => term.key);

const pickedSnapshots = (snapshots: readonly SavedMarketSnapshot[], kind: TrendKind, basis: MarketBasis) => snapshots.flatMap((snapshot) => {
  const bounds = periodBounds(kind, snapshot.info.label);

  return bounds && snapshot.info.basis === basis ? [{ ...snapshot, bounds }] : [];
}).sort((a, b) => codepointOrder(a.bounds[0], b.bounds[0]) || codepointOrder(a.info.label, b.info.label));

export const trendSeries = (snapshots: readonly SavedMarketSnapshot[], tax: Taxonomy, kind: TrendKind, basis: MarketBasis, today: string) => {
  const picked = pickedSnapshots(snapshots, kind, basis);
  const coverage = picked.map((item) => periodCoverage(item.info, item.bounds, today));

  return {
    kind, basis, labels: picked.map((item) => item.info.label),
    ad_counts: picked.map((item) => item.info.ad_count),
    tech_totals: picked.map((item) => techTotal(item.counts.families)),
    family_counts: Object.fromEntries(familyKeys(tax).map((key) => [key, picked.map((item) => item.counts.families[key] ?? 0)])),
    partial: coverage.map((status) => status !== "closed"),
    taxonomy_versions: picked.map((item) => item.info.taxonomy_version), coverage,
  };
};

// Snapshot v1 fills missing calendar periods with nulls, unlike the retained low-level trend series.
export const marketSeries = (snapshots: readonly SavedMarketSnapshot[], tax: Taxonomy, kind: TrendKind, today: string) => {
  const picked = pickedSnapshots(snapshots, kind, "titles");

  if (!picked.length) return Either.right(null);
  const byLabel = new Map(picked.map((item) => [item.info.label, item]));
  const first = picked[0], last = picked.at(-1);

  if (!first || !last) return Either.right(null);
  const periods: { label: string; start: string | null; end: string | null; partial: boolean | null; ad_count: number | null; tech_total: number | null; sampled: boolean | null; taxonomy_version: string | null; captured_at: string | null; coverage: string }[] = [];
  const loaded: (SavedMarketSnapshot["counts"] | null)[] = [];
  let current = first.bounds[0];

  while (current <= last.bounds[0]) {
    if (periods.length >= 1200) return Either.left(new MarketError({ message: "Market history exceeds 1200 periods" }));
    const label = periodLabel(kind, current);
    const bounds = periodBounds(kind, label);

    if (!bounds) return Either.left(new MarketError({ message: "Invalid market period" }));
    const saved = byLabel.get(label), info = saved?.info;
    loaded.push(saved?.counts ?? null);
    const coverage = info ? periodCoverage(info, bounds, today) : "missing";
    periods.push({
      label, start: info?.period_start ?? null, end: info?.period_end ?? null,
      partial: info ? coverage !== "closed" : null, ad_count: info?.ad_count ?? null,
      tech_total: saved ? techTotal(saved.counts.families) : null,
      sampled: info?.sampled ?? null, taxonomy_version: info?.taxonomy_version ?? null,
      captured_at: info?.created_at ?? null, coverage,
    });
    current = nextPeriod(bounds);
  }

  const families = [...new Set([...familyKeys(tax), ...loaded.flatMap((item) => Object.keys(item?.families ?? {}))])];
  const terms = [...new Set([...termKeys(tax), ...loaded.flatMap((item) => Object.keys(item?.terms ?? {}))])];

  return Either.right({
    periods,
    families: families.map((key) => ({ key, label: key === "other" ? "Other" : tax.families.find((family) => family.key === key)?.label ?? key, counts: loaded.map((item) => item?.families[key] ?? null) })),
    terms: terms.map((key) => {
      const term = tax.terms.find((item) => item.key === key);

      return { key, group: term?.group ?? "retained", label: term?.label ?? key, counts: loaded.map((item) => item?.terms[key] ?? null), tech_counts: loaded.map((item) => item?.tech_terms[key] ?? null) };
    }),
  });
};

export const marketSection = (snapshots: readonly SavedMarketSnapshot[], tax: Taxonomy, today: string) => {
  if (!tax.enabled) return Either.right(null);

  return Either.gen(function* () {
    const monthly = yield* marketSeries(snapshots, tax, "month", today);
    const weekly = yield* marketSeries(snapshots, tax, "week", today);

    if (monthly === null && weekly === null) return null;
    const infos = snapshots.filter((item) => item.info.basis === "titles" && (periodBounds("month", item.info.label) || periodBounds("week", item.info.label)));

    return {
      taxonomy_version: tax.version,
      captured_at: infos.map((item) => item.info.created_at).sort(codepointOrder).at(-1) ?? "",
      monthly: monthly ?? { periods: [], families: [], terms: [] }, weekly,
      note: "Recorded titles-only aggregates from the monitored NAV sample.",
    };
  });
};

export const funnelTrend = (ads: readonly MarketAd[], tax: Taxonomy, kind: TrendKind, today: string) => {
  const groups = new Map<string, MarketAd[]>();
  const days: string[] = [];

  for (const ad of ads) {
    const day = parseIsoDate(ad.published.slice(0, 10));

    if (Option.isNone(day)) continue;
    days.push(day.value.text);
    const label = periodLabel(kind, day.value.text);
    groups.set(label, [...(groups.get(label) ?? []), ad]);
  }

  const periods: { label: string; start: string; end: string; counts: SnapshotCounts }[] = [];

  if (days.length) {
    days.sort(codepointOrder);
    const first = days[0], latest = days.at(-1);

    if (first && latest) {
      let current = kind === "month" ? `${first.slice(0, 7)}-01` : dayText(Date.parse(`${first}T00:00:00Z`) - (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7 * dayMillis);
      const horizon = today > latest ? today : latest;

      while (current <= horizon) {
        const label = periodLabel(kind, current);
        const bounds = periodBounds(kind, label);

        if (!bounds) break;
        periods.push({ label, start: bounds[0], end: bounds[1], counts: countSnapshot(groups.get(label) ?? [], tax) });
        current = nextPeriod(bounds);
      }
    }
  }

  return {
    kind, periods,
    series: {
      kind, basis: "titles" as const, labels: periods.map((item) => item.label), ad_counts: periods.map((item) => item.counts.ad_count),
      tech_totals: periods.map((item) => techTotal(item.counts.families)),
      family_counts: Object.fromEntries(familyKeys(tax).map((key) => [key, periods.map((item) => item.counts.families[key] ?? 0)])),
      partial: periods.map((item) => item.end >= today), taxonomy_versions: periods.map(() => tax.version), coverage: [],
    },
  };
};

export const reviewedTrendSection = (ads: readonly MarketAd[], listingIds: ReadonlySet<string>, tax: Taxonomy, today: string) => {
  const funnel = titlesOnly(ads.filter((ad) => listingIds.has(ad.uuid)));

  return Object.fromEntries((["week", "month"] as const).map((kind) => [kind === "week" ? "weekly" : "monthly", funnelTrend(funnel, tax, kind, today).periods.map((period) => ({ label: period.label, start: period.start, count: period.counts.ad_count }))]));
};

export const funnelMarketContext = (ads: readonly MarketAd[] | null, listingIds: ReadonlySet<string>, verified: boolean, tax: Taxonomy, today: string): string | null => {
  if (!tax.enabled || !verified) return null;

  if (ads === null) return "Your reviewed jobs: the NAV feed could not be read, so no counts are shown.";
  const latest = funnelTrend(titlesOnly(ads.filter((ad) => listingIds.has(ad.uuid))), tax, "month", today).periods.at(-1);

  if (!latest) return "Your reviewed jobs: none is in the NAV ads table, so no counts are shown.";
  const labels = new Map(tax.families.map((family) => [family.key, family.label]));
  const families = Object.entries(latest.counts.families).filter(([key, count]) => key !== "other" && count > 0).map(([key, count]) => ({ count, label: (labels.get(key) ?? key).trim().split(/\s+/u).join(" ").slice(0, 80) || "unknown" })).sort((a, b) => b.count - a.count || codepointOrder(a.label, b.label)).slice(0, 3);
  const lines = [`Your reviewed jobs first seen in ${latest.label}${latest.end >= today ? " (partial)" : ""}: ${latest.counts.ad_count} ads, ${techTotal(latest.counts.families)} tech/data roles.`];

  if (families.length) lines.push(`Leading families: ${families.map((item) => `${item.label} ${item.count}`).join(", ")}.`);
  lines.push("Latest month only; no trend is claimed.");

  return lines.join("\n");
};

export const unknownWordRises = (previous: Record<string, number>, previousTotal: number, latest: Record<string, number>, latestTotal: number) => Object.entries(latest).filter(([word, count]) => count >= 3 && count / latestTotal > (previous[word] ?? 0) / previousTotal).map(([word, count]) => ({ word, previous_count: previous[word] ?? 0, latest_count: count, previous_share: (previous[word] ?? 0) / previousTotal, latest_share: count / latestTotal })).sort((a, b) => ((b.latest_share - b.previous_share) - (a.latest_share - a.previous_share)) || b.latest_count - a.latest_count || codepointOrder(a.word, b.word)).slice(0, 20);

export const risingUnknownTitleWords = (snapshots: readonly SavedMarketSnapshot[], kind: TrendKind, basis: MarketBasis, today: string) => {
  const picked = pickedSnapshots(snapshots, kind, basis);
  const previous = picked.at(-2), latest = picked.at(-1);
  const result = (reason: string | null) => ({ kind, basis, status: reason === null ? "available" : "unknown", reason, previous_label: previous?.info.label ?? null, latest_label: latest?.info.label ?? null, minimum_support: 3, rises: reason === null && previous && latest ? unknownWordRises(previous.unknown_words ?? {}, previous.info.ad_count, latest.unknown_words ?? {}, latest.info.ad_count) : [] });

  if (!snapshots.length) return result("no_market_snapshots");

  if (snapshots.every((snapshot) => snapshot.unknown_words === null)) return result("word_counts_not_available");

  if (!previous || !latest) return { ...result("need_two_periods"), previous_label: null, latest_label: null };

  if (latest.bounds[1] >= today) return result("latest_period_open");

  if (nextPeriod(previous.bounds) !== latest.bounds[0]) return result("period_gap");

  if (previous.info.taxonomy_version !== latest.info.taxonomy_version) return result("taxonomy_mismatch");

  if (previous.info.sampled || latest.info.sampled) return result("sampled_coverage");

  if (!previous.info.ad_count || !latest.info.ad_count) return result("empty_snapshot");

  if (previous.words_complete === null || latest.words_complete === null) return result("word_counts_not_recorded");

  if (!previous.words_complete || !latest.words_complete) return result("word_vocabulary_truncated");

  return result(null);
};

export const snapshotOrder = (a: SnapshotInfo, b: SnapshotInfo): number => codepointOrder(a.period_start ?? a.label, b.period_start ?? b.label) || codepointOrder(a.label, b.label);
