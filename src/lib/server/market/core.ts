import type { MarketAd, SnapshotCounts } from "../../contracts/market.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { caseFold } from "../shared/text.ts";
import type { Taxonomy } from "./taxonomy.ts";

const coreData = new Set(["data_science", "data_engineering", "analytics_bi"]);
const matches = (patterns: readonly RegExp[], value: string) => patterns.some((pattern) => pattern.test(value));
const score = (family: Taxonomy["families"][number], text: string) => family.text.filter((pattern) => pattern.test(text)).length;

export interface Classification { readonly family: string; readonly method: string }

export const classifyDetail = (ad: MarketAd, tax: Taxonomy): Classification => {
  if (!tax.enabled) return { family: "other", method: "disabled" };

  if (matches(tax.title_exclusions, ad.title)) return { family: "other", method: "excluded-title" };
  const text = `${ad.text} ${ad.occupations}`;
  const specific = tax.families.filter((family) => family.key !== "mixed_data");
  const hits = specific.filter((family) => matches(family.title, ad.title));

  if (hits.filter((family) => coreData.has(family.key)).length >= 2) return { family: "mixed_data", method: "mixed-title" };

  if (hits.length === 1) return { family: hits[0]!.key, method: "title" };
  const best = (families: typeof specific) => families.reduce((left, right) => score(right, text) > score(left, text) ? right : left);

  if (hits.length) return { family: best(hits).key, method: "title-tie" };
  const mixed = tax.families.find((family) => family.key === "mixed_data");

  if (mixed && matches(mixed.title, ad.title)) return { family: "mixed_data", method: "generic-title" };

  if (specific.length) {
    const winner = best(specific);

    if (score(winner, text) >= tax.text_min_hits) return { family: winner.key, method: "text" };
  }

  return { family: "other", method: "none" };
};

export const classify = (ad: MarketAd, tax: Taxonomy): string => classifyDetail(ad, tax).family;
export const termsIn = (ad: MarketAd, tax: Taxonomy): Set<string> => new Set(tax.terms.filter((term) => term.pattern.test(`${ad.title} ${ad.text} ${ad.occupations}`)).map((term) => term.key));

export const uniqueAds = (ads: Iterable<MarketAd>): MarketAd[] => {
  const seen = new Set<string>();

  return Array.from(ads).filter((ad) => {
    if (!ad.uuid) return true;

    if (seen.has(ad.uuid)) return false;
    seen.add(ad.uuid);

    return true;
  });
};

export const titlesOnly = (ads: Iterable<MarketAd>): MarketAd[] => Array.from(ads, (ad) => ({ ...ad, text: "", occupations: "" }));
export const techTotal = (families: Readonly<Record<string, number>>): number => Object.entries(families).reduce((sum, [key, count]) => sum + (key === "other" ? 0 : count), 0);

export const countSnapshot = (ads: Iterable<MarketAd>, tax: Taxonomy): SnapshotCounts => {
  const rows = uniqueAds(ads);
  const families: Record<string, number> = Object.fromEntries([...tax.families.map((family) => family.key), "other"].map((key) => [key, 0]));
  const terms: Record<string, number> = Object.fromEntries(tax.terms.map((term) => [term.key, 0]));
  const tech_terms = { ...terms };

  for (const ad of rows) {
    const family = classify(ad, tax);
    families[family] = (families[family] ?? 0) + 1;

    for (const key of termsIn(ad, tax)) {
      terms[key] = (terms[key] ?? 0) + 1;

      if (family !== "other") tech_terms[key] = (tech_terms[key] ?? 0) + 1;
    }
  }

  return { ad_count: rows.length, families, terms, tech_terms };
};

const stopwords = new Set("and as at av be den der det du en et for fra from i in med og om on or på som the til to ved vi with senior junior principal staff lead team head developer utvikler engineer ingeniør ingenior designer design analyst analytiker konsulent consultant specialist spesialist rådgiver radgiver advisor manager leder officer stilling position role job jobs candidate".split(" "));
const tokens = (value: string): string[] => value.match(/[\p{L}\p{Nl}\p{No}]{3,}/gu) ?? [];

export const unknownTitleWordCounts = (ads: Iterable<MarketAd>, tax: Taxonomy): Record<string, number> => {
  const known = new Set(stopwords);

  for (const label of [...tax.families.map((family) => family.label), ...tax.terms.map((term) => term.label)]) {
    for (const word of tokens(label)) known.add(caseFold(word));
  }

  const patterns = [...tax.families.flatMap((family) => family.title), ...tax.terms.map((term) => term.pattern), ...tax.title_exclusions];
  const counts = new Map<string, number>();

  for (const ad of uniqueAds(ads)) {
    let remainder = Array.from(ad.title).slice(0, 240).join("");

    for (const pattern of patterns) remainder = remainder.replace(new RegExp(pattern.source, pattern.flags + "g"), " ");
    const words = new Set(tokens(remainder).map(caseFold).filter((word) => !known.has(word)));

    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return Object.fromEntries([...counts].sort(([a, ac], [b, bc]) => bc - ac || codepointOrder(a, b)).slice(0, 500));
};
