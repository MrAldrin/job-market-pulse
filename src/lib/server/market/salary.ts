import type { SalaryFacts } from "../../contracts/salary.ts";
import { decimalText, pythonDigitClass as D, pythonWordClass as W, words } from "../shared/text.ts";
import { unescapeHtml } from "../shared/html.ts";

const boundary = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const space = "[\\p{White_Space}\\u001c-\\u001f]";
const grouped = `${D}{1,3}(?:[ .]${D}{3})+`;
const big = `(?:${grouped}|${D}{4,})`;
const any = `(?:${grouped}|${D}+)(?:,${D}{1,2})?`;
const end = `(?!${D})(?![.,]${D})`;
const lead = `(?<!${W})(?:kr\\.?|nok)${space}*`;
const tail = `(?:kroner|kr${boundary}(?:\\.(?!${space}+(?-i:[A-ZÆØÅ])|${space}*$))?|nok${boundary}|,-)`;
const rx = (pattern: string, flags = "iu"): RegExp => new RegExp(pattern, flags);
const range = rx(`(?:${lead})?(?<!${D})(?<!${D}[ .])(?<low>${big}|${D}{1,3})${end}(?:${space}*${tail})?${space}*(?:-|til)${space}*(?:${lead})?(?<high>${big}|${D}{1,3})${end}(?:${space}*${tail})?`, "giu");
const single = rx(`${lead}(?<lead>${any})${end}|(?<!${D})(?<bare>${any})${end}(?:${space}*${tail})?`, "giu");
const label = rx(`(?<!${W})(?:[åa]rsl[øo]nn|m[åa]nedsl[øo]nn|l[øo]nnsspenn|l[øo]nnsramme|l[øo]nnsomr[åa]de|l[øo]nnsplassering|timel[øo]nn|l[øo]nnes|l[øo]nn)(?:en|et|a|n)?(?!${W})`);
const sko = rx(`(?<!${W})(?:[sSſ][tT][iIİı][lL][lL][iIİı][nN][gG][sSſ][kKK][oO][dD][eE]|SKO)(?:${space}*[nN][rR]\\.?)?[:#.\\-]?${space}*(${D}{4})(?!${D})`, "gu");
const ltr = rx(`(?<!${W})(?:l[øo]nnstrinn|ltr)[.:]?${space}*(${D}{1,2})(?!${D})(?:${space}*(?:-|til)${space}*(${D}{1,2})(?!${D}))?`, "giu");

const periods: readonly [NonNullable<SalaryFacts["period"]>, RegExp][] = [
  ["hour", rx(`/${space}*(?:time|t)${boundary}|${boundary}(?:per|pr\\.?)${space}*(?:time|t)${boundary}|timel[øo]nn|timepris`, "giu")],
  ["month", rx(`/${space}*(?:mnd|m[åa]ned)${boundary}|${boundary}(?:per|pr\\.?)${space}*(?:mnd|m[åa]ned)${boundary}|${boundary}i${space}+m[åa]neden${boundary}|${boundary}i${space}+m[åa]ned${boundary}|m[åa]nedsl[øo]nn|m[åa]nedlig`, "giu")],
  ["year", rx(`/${space}*år${boundary}|${boundary}(?:per|pr\\.?)${space}*år${boundary}|${boundary}i${space}+året${boundary}|${boundary}(?:år|års)l[øo]nn|${boundary}årlig`, "giu")],
];

const field = `${D}|[;\\n|•]|,(?![${D.slice(1, -1)}-])|(?<!${boundary}pr)(?<!${boundary}kr)(?<!${boundary}nr)\\.(?!${D})|(?<=${boundary}kr)\\.(?=${space}+(?-i:[A-ZÆØÅ]))`;
const beforeExclusion = rx(`${D}|[.;\\n|•,)]|${boundary}og${boundary}`, "iu");
const afterExclusion = rx(`${D}|[.;:\\n|•,(]|${boundary}og${boundary}`, "iu");
const bonusBefore = rx(`bonus|tillegg|${boundary}pensjon${boundary}|provisjon|feriepenger|${boundary}otp${boundary}|budsjett|${boundary}stipend${boundary}|gebyr|avgift|godtgj[øo]relse|dagpenger|kompensasjon`);
const bonusAfter = rx(`bonus|tillegg|provisjon|budsjett|${boundary}stipend${boundary}|gebyr|avgift|godtgj[øo]relse|dagpenger|kompensasjon`);
const maxBefore = rx(`(?<!${W})(?:inntil|opptil|maks(?:imalt)?\\.?)${space}*$`);
const amountTail = rx(`${D}${space}*(?:kroner|kr\\.?|nok|,-)?${space}*$`);
const vague = rx(`konkurransedyktig${W}*${space}+l[øo]nn${W}*|l[øo]nn${W}*${space}+etter${space}+(?:avtale|kvalifikasjon${W}*|kompetanse|erfaring)`);
const monthly = rx(`^${space}*i${space}+m[åa]neden${boundary}`);
const fromUpto = rx(`(${boundary}fra${space}+(?:kr\\.?${space}*|nok${space}*)?${D}[${D.slice(1, -1)} .]*${D}(?:${space}*kr\\.?)?)${space}*,?${space}*(?:og${space}+)?(?:opptil|inntil)${space}+`, "giu");

type Amount = { form: "single" | "range" | "max"; low: number; high: number; period: SalaryFacts["period"]; inferred: boolean; labelled: boolean };

const sliceBefore = (text: string, endIndex: number, count: number): string => Array.from(text.slice(0, endIndex)).slice(-count).join("");
const sliceAfter = (text: string, start: number, count: number): string => Array.from(text.slice(start)).slice(0, count).join("");
const firstSplit = (text: string, pattern: RegExp): string => text.split(pattern)[0] ?? "";
const lastSplit = (text: string, pattern: RegExp): string => text.split(pattern).at(-1) ?? "";
const marker = (text: string): boolean => /kr|nok|,-/iu.test(text);
const isBig = (raw: string): boolean => /[ .]/u.test(raw.split(",")[0] ?? "") || Array.from(raw.split(",")[0] ?? "").filter((c) => rx(`^${D}$`, "u").test(c)).length >= 4;

const value = (raw: string): number => {
  const [whole = "", cents = ""] = raw.split(",");
  const digits = Array.from(whole).filter((c) => rx(`^${D}$`, "u").test(c)).join("");
  const number = Array.from(digits).length <= 12 ? Number(decimalText(digits)) : 0;

  return number && cents ? number + Number(`0.${decimalText(cents)}`) : number;
};

const yearLike = (raw: string): boolean => rx(`^${D}{4}$`, "u").test(raw) && Number(decimalText(raw)) >= 1900 && Number(decimalText(raw)) <= 2100;
const labelled = (text: string, start: number): boolean => label.test(lastSplit(sliceBefore(text, start, 60).replace(rx(`${boundary}maks\\.`, "giu"), "maks"), /[.;\n|•]/u));

const explicitPeriod = (text: string, start: number, endIndex: number): SalaryFacts["period"] => {
  const after = firstSplit(sliceAfter(text, endIndex, 24), rx(`${field}|:`, "iu"));

  for (const [period, pattern] of periods) { pattern.lastIndex = 0;

 if (pattern.test(after)) return period; }

  const before = lastSplit(sliceBefore(text, start, 24), rx(field, "iu"));
  const offset = start - before.length;
  const stem = before.replace(/[ :]+$/u, "").replace(maxBefore, "").replace(/[ :]+$/u, "");

  for (const [period, pattern] of periods) {
    pattern.lastIndex = 0;

    for (const match of stem.matchAll(pattern)) {
      if ((match.index ?? 0) + match[0].length === stem.length && !amountTail.test(sliceBefore(text, offset, 12) + stem.slice(0, match.index))) return period;
    }
  }

  return null;
};

const excluded = (text: string, start: number, endIndex: number): boolean => {
  const before = lastSplit(sliceBefore(text, start, 80), beforeExclusion);
  const after = firstSplit(sliceAfter(text, endIndex, 80), afterExclusion);
  const bonuses = [...before.matchAll(rx(bonusBefore.source, "giu"))];
  const labels = [...before.matchAll(rx(label.source, "giu"))];

  if (bonuses.length && (!labels.length || (labels.at(-1)?.index ?? 0) <= (bonuses.at(-1)?.index ?? 0))) return true;

  if (rx(`${boundary}org\\.?${space}*nr${boundary}`).test(sliceBefore(text, start, 20))) return true;

  if (rx(`^${space}*(?:\\+|pluss|(?:${W}+${space}+){0,2}i${space}+tillegg${space}+til${boundary})`).test(after)) return false;

  return bonusAfter.test(words(after).slice(0, 3).join(" "));
};

export const extractSalary = (input: string): SalaryFacts => {
  // Python re.IGNORECASE includes these two characters in ASCII i's case set.
  const text = unescapeHtml(input.replace(/<[^>]{0,200}>/gu, " "))
    .replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/gu, "")
    // Python whitespace includes these C0 separators, but not U+FEFF.
    // oxlint-disable-next-line no-control-regex
    .replace(/[^\S\n\ufeff]|[\u001c-\u001f\u0085]/gu, " ")
    .replace(/[\u2010-\u2015\u2212]/gu, "-").replace(/[İı]/gu, "i").replace(fromUpto, "$1 - ");

  const codes = [...text.matchAll(sko)];
  const grades = [...text.matchAll(ltr)];
  const taken = [...codes, ...grades].map((m) => [m.index, m.index + m[0].length] as const);
  let amounts: Amount[] = [];

  for (const match of text.matchAll(range)) {
    const start = match.index, endIndex = start + match[0].length;

    if (taken.some(([a, b]) => a < endIndex && start < b)) continue;
    const lowRaw = match.groups?.low ?? "", highRaw = match.groups?.high ?? "";
    const short = !isBig(lowRaw) && !isBig(highRaw), explicit = explicitPeriod(text, start, endIndex);

    if (short && !explicit) continue;
    taken.push([start, endIndex]);

    if (yearLike(lowRaw) || yearLike(highRaw)) continue;
    const hasLabel = labelled(text, start);

    if (!(marker(match[0]) || hasLabel || monthly.test(sliceAfter(text, endIndex, 20))) && !(short && explicit)) continue;

    if (excluded(text, start, endIndex)) continue;
    const groups = (highRaw.split(",")[0] ?? "").split(/[ .]/u);
    const low = value(lowRaw) * (!isBig(lowRaw) && groups.length >= 2 && Array.from(groups[0] ?? "").length === Array.from(lowRaw).length ? 1000 ** (groups.length - 1) : 1);
    const high = value(highRaw), lowest = Math.min(low, high);

    if (!explicit && !hasLabel && lowest < 100000) continue;
    const period = explicit ?? (hasLabel && lowest >= 100000 ? "year" : null);
    amounts.push({ form: "range", low: lowest, high: Math.max(low, high), period, inferred: !explicit && period !== null, labelled: hasLabel });
  }

  for (const match of text.matchAll(single)) {
    const start = match.index, endIndex = start + match[0].length;

    if (taken.some(([a, b]) => a < endIndex && start < b)) continue;
    const raw = match.groups?.lead || match.groups?.bare || "", hasLabel = labelled(text, start);

    if (!marker(match[0]) && !hasLabel && !monthly.test(sliceAfter(text, endIndex, 20))) continue;
    const explicit = explicitPeriod(text, start, endIndex);

    if (!explicit && (!isBig(raw) || yearLike(raw))) continue;
    const number = value(raw);

    if ((!explicit && !hasLabel && number < 100000) || excluded(text, start, endIndex)) continue;
    let period = explicit ?? (hasLabel && number >= 100000 ? "year" : null), inferred = !explicit && period !== null;
    const ceiling = maxBefore.test(sliceBefore(text, start, 20));

    if (ceiling && !hasLabel) { if (!marker(match[0]) || number < 100000) continue; period = explicit; inferred = false; }

    amounts.push({ form: ceiling ? "max" : "single", low: number, high: number, period, inferred, labelled: hasLabel });
  }

  amounts = amounts.filter((a) => a.low > 0);

  if (amounts.some((a) => a.labelled)) amounts = amounts.filter((a) => a.labelled);

  if (amounts.some((a) => a.form !== "max")) amounts = amounts.filter((a) => a.form !== "max");
  let form: SalaryFacts["form"] = null, low: number | null = null, high: number | null = null, period: SalaryFacts["period"] = null, inferred = false;

  if (!amounts.length) { if (vague.test(text)) form = "vague"; }
  else if (new Set(amounts.map((a) => a.period)).size === 1) {
    period = amounts[0]?.period ?? null; inferred = amounts.every((a) => a.inferred); high = amounts.reduce((max, a) => Math.max(max, a.high), 0);

    if (amounts[0]?.form === "max") form = "max";
    else { low = amounts.reduce((min, a) => Math.min(min, a.low), Infinity); form = low !== high || amounts.some((a) => a.form === "range") ? "range" : "single"; }
  }

  const grade = grades[0];
  const first = grade ? Number(decimalText(grade[1] ?? "")) : null, second = grade ? Number(decimalText(grade[2] ?? grade[1] ?? "")) : null;

  return { form, min_nok: low, max_nok: high, period, sko_code: codes[0]?.[1] ?? null, ltr_min: first === null || second === null ? null : Math.min(first, second), ltr_max: first === null || second === null ? null : Math.max(first, second), period_inferred: inferred, amount_unclear: amounts.length > 0 && form === null };
};
