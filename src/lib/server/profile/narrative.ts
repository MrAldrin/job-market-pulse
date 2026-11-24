import { Either, flow, Schema } from "effect";
import { decodeStrict } from "../../contracts/support.ts";
import { caseFold, decimalDigit, decimalText, pythonAlnumClass, pythonDigitClass, pythonWordClass, words } from "../shared/text.ts";
import { parseToml } from "../shared/toml.ts";
import { ProfileError } from "./errors.ts";

export const sections = ["# Profile", "## Who I am", "## What I want next", "## What makes a job exceptional for me", "## What I do not want", "## Hard limits", "## Preferences", "## Examples", "## Notes for the reviewer"] as const;
export const sectionHeadings = { background: sections[1], direction: sections[2], wants: sections[3], avoid: sections[4], hard_limits: sections[5], practical: sections[6], examples: sections[7], reviewer_notes: sections[8] };
const Question = Schema.Struct({ id: Schema.String, section: Schema.String, ask: Schema.String, why: Schema.String, follow_up: Schema.Array(Schema.String), short: Schema.Boolean, hard: Schema.Boolean });
const Bank = Schema.Struct({ question: Schema.Array(Question) });

export type Question = typeof Question.Type;

const failure = (message: string) => Either.left(new ProfileError({ message }));
export const decodeQuestions = (text: string, short = false): Either.Either<readonly Question[], ProfileError> => Either.flatMap(parseToml(text), (raw) => Either.map(Either.mapLeft(decodeStrict(Bank)(raw), () => new ProfileError({ message: "Invalid interview question bank" })), (bank) => bank.question.filter((q) => !short || q.short)));

// Match Python str.strip rather than JavaScript trim (notably U+0085 and U+FEFF).
// eslint-disable-next-line no-control-regex
const strip = (text: string): string => text.replace(/^[\p{White_Space}\x1c-\x1f]+|[\p{White_Space}\x1c-\x1f]+$/gu, "");
const content = (text: string) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
const filler = new Set(["", "not stated", "todo", "tbd", "n/a", "n-a", "unknown", "placeholder", "no strict limits stated", "no hard limits stated", "not applicable", "none", "yes", "no", "no examples provided", "facts not stated in this short form remain unknown. no examples were requested", "unstated facts remain unknown", "strict", "prefer", "unknown facts", "reviewer notes"]);

// Python splitlines includes these control-character separators.
// eslint-disable-next-line no-control-regex
const splitLines = (text: string) => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);

const fence = new RegExp("^(?:`{3,}|~{3,})(?:" + pythonWordClass + "|[+-])*$", "u");
const bulletPrefix = new RegExp("^(?:[-*+]|" + pythonDigitClass + "+[.)])[\\p{White_Space}\\x1c-\\x1f]*", "u");

// Python re.I includes dotted/dotless I and long S for these ASCII letters.
// Keep this a fixed-prefix rule, not a broad case-folded grammar.
// The caller strips whitespace after removing the prefix.
const limitPrefix = /^(?:[sSſ][tT][rR][iIİı][cC][tT]|[pP][rR][eE][fF][eE][rR]):/u;
const meaningfulCharacter = new RegExp(pythonAlnumClass, "u");
const hardLimitBullet = new RegExp("^[\\p{White_Space}\\x1c-\\x1f]*(?:[-*+]|" + pythonDigitClass + "+[.)])[\\p{White_Space}\\x1c-\\x1f]+(.+)", "u");
const phoneNumber = new RegExp("(?<!" + pythonWordClass + ")\\+?" + pythonDigitClass + "(?:" + pythonDigitClass + "|[ ()-])*" + pythonDigitClass + "(?!" + pythonWordClass + ")", "gu");
const dateNumber = new RegExp("^" + pythonDigitClass + "{4}-" + pythonDigitClass + "{2}-" + pythonDigitClass + "{2}$", "u");

export const hasMeaningfulContent = (text: string): boolean => splitLines(content(text)).some((raw) => {
  let line = strip(raw);

  if (!line || line.startsWith("#") || fence.test(line)) return false;
  line = strip(strip(line.replace(bulletPrefix, "")).replace(limitPrefix, ""));
  const value = caseFold(line).replace(/^[ .:;![\]()<>*_`|]+|[ .:;![\]()<>*_`|]+$/g, "");

  return !filler.has(value) && !/^(?:add|insert|enter) your (?:experience|answer|background|skills) here$/.test(value) && !/^(?:lorem ipsum(?: dolor sit amet(?:,? consectetur adipiscing elit)?)?[ .,!;]*)+$/.test(value) && meaningfulCharacter.test(value);
});

export const checkNarrative = (text: string, { requireTemplate = true, requireMinimum = true }: { readonly requireTemplate?: boolean; readonly requireMinimum?: boolean } = {}): readonly string[] => {
  const visible = content(text);
  const lines = splitLines(visible);
  const problems: string[] = requireTemplate ? sections.flatMap((heading) => lines.includes(heading) ? [] : [`Add the heading ${heading}.`]) : [];

  // Python whitespace includes U+001C through U+001F.
  // eslint-disable-next-line no-control-regex
  if (requireTemplate && requireMinimum && Array.from(visible.replace(/[\p{White_Space}\x1c-\x1f]/gu, "")).length < 200) problems.push("Add at least 200 non-comment characters.");

  if (!hasMeaningfulContent(text)) problems.push("Add meaningful personal evidence.");
  let inLimits = false;

  for (const line of lines) {
    if (line.startsWith("#")) inLimits = line === sections[5];
    const bullet = hardLimitBullet.exec(line);

    if (requireTemplate && inLimits && bullet && !bullet[1]!.startsWith("STRICT:")) { problems.push("Start every hard-limit bullet with STRICT:."); break; }
  }

  for (const number of visible.matchAll(phoneNumber)) {
    const value = strip(number[0]);
    const digits = Array.from(value).filter(decimalDigit).length;

    if (!dateNumber.test(value) && digits >= 8 && digits <= 15) { problems.push("Remove phone numbers and personal ID numbers."); break; }
  }

  if (words(visible).length > 1500) problems.push("Reduce the profile to at most 1,500 words.");

  return problems;
};

export const fillTemplate = (template: string, answers: Readonly<Record<string, string>>): string => {
  const byHeading = new Map<string, string>(Object.entries(sectionHeadings).map(([key, heading]) => [heading, strip(answers[key] ?? "")]));
  const output: string[] = [];
  let active = "";

  for (const line of splitLines(template).slice(0, template.endsWith("\n") ? -1 : undefined)) {
    output.push(line);

    if (sections.some((heading) => heading === line)) active = line;
    else if (line.startsWith("<!--") && active) {
      const answer = byHeading.get(active);

      if (answer) output.push("", answer);
      active = "";
    }
  }

  // eslint-disable-next-line no-control-regex
  return output.join("\n").replace(/[\p{White_Space}\x1c-\x1f]+$/gu, "") + "\n";
};

export const normalizeSalary = (raw: string): Either.Either<string, ProfileError> => {
  const value = strip(raw);

  if (!value) return Either.right("");

  if (!/^[0-9]+$/.test(value) || !/[1-9]/.test(value)) return failure("Enter a positive whole NOK amount or leave it empty.");

  return Either.right(value.replace(/^0+/, ""));
};

export const normalizeWorkplace = (raw: string): Either.Either<string, ProfileError> => {
  const value = strip(raw).toLowerCase();

  if (!value || value === "none") return Either.right("");

  if (value === "all") return Either.right("1,2,3");

  // eslint-disable-next-line no-control-regex
  if (!/^[123](?:[\p{White_Space}\x1c-\x1f]*[, ][\p{White_Space}\x1c-\x1f]*[123])*$/u.test(value)) return failure("Select arrangement numbers 1, 2 and/or 3, all, or none.");

  return Either.right([...new Set(value.match(/[123]/g))].sort().join(","));
};

export const Answers = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export type Answers = typeof Answers.Type;

export const decodeAnswers = flow(decodeStrict(Answers), Either.mapLeft(() => new ProfileError({ message: "Invalid interview answers" })));

// Python int strings accept Unicode decimal digits and single inter-digit underscores.
const followupIndex = (raw: string): number => {
  const value = decimalText(strip(raw));

  return /^[+-]?[0-9](?:_?[0-9])*$/.test(value) ? Number(value.replaceAll("_", "")) : -1;
};

export const renderAnswers = (template: string, questions: readonly Question[], answers: Answers, short = false): Either.Either<string, ProfileError> => Either.gen(function* () {
  const grouped: Record<string, string[]> = {};

  for (const q of questions.filter((item) => !short || item.short)) {
    const rawAnswer = answers[`interview_${q.id}`];
    const answer = Schema.is(Schema.String)(rawAnswer) ? strip(rawAnswer) : "";

    if (!hasMeaningfulContent(answer)) continue;
    let target = q.section;
    let line: string;

    if (q.id === "minimum_salary") {
      const amount = yield* normalizeSalary(answer);
      line = `- STRICT: Minimum annual salary is ${amount.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} NOK before tax for full-time work. If the ad does not state salary, salary compatibility is unknown.`;
    } else if (q.id === "work_location") {
      const selected = yield* normalizeWorkplace(answer);

      if (!selected) continue;
      const names = new Map([["1", "on-site"], ["2", "hybrid"], ["3", "fully remote"]]);
      line = `- STRICT: Equally acceptable work arrangements: ${selected.split(",").map((n) => names.get(n)).join(", ")}. An explicitly incompatible arrangement fails; an unstated arrangement remains unknown.`;
    } else {
      const rawStrict = answers[`interview_${q.id}_strict`];
      const strict = strip(Schema.is(Schema.String)(rawStrict) ? rawStrict : "").toLowerCase();

      if (q.hard && strict === "yes") { target = "hard_limits"; line = `- STRICT: ${q.ask} ${answer}`; }
      else if (q.hard) { target = "practical"; line = `${strict === "no" ? "- PREFER: " : ""}${q.ask} ${answer}`; }
      else line = `${q.ask} ${answer}`;
    }

    const lines = grouped[target] ?? (grouped[target] = []);
    lines.push(line);
    const follow = answers[`interview_${q.id}_followup_answer`];
    const index = answers[`interview_${q.id}_followup_index`];
    const integer = Schema.is(Schema.Int)(index) ? index : Schema.is(Schema.String)(index) ? followupIndex(index) : -1;

    if (Schema.is(Schema.String)(follow) && hasMeaningfulContent(follow) && integer >= 0 && integer < q.follow_up.length) lines.push(`${target === "hard_limits" ? "- STRICT: " : ""}${q.follow_up[integer]} ${strip(follow)}`);
  }

  return fillTemplate(template, Object.fromEntries(Object.entries(grouped).map(([key, lines]) => [key, lines.join("\n")])));
});

interface Boundary { readonly heading: string; readonly start: number; readonly bodyStart: number }

const boundaries = (original: Uint8Array): Either.Either<readonly Boundary[], ProfileError> => Either.gen(function* () {
  const text = yield* Either.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original), catch: () => new ProfileError({ message: "Cannot safely edit this profile." }) });

  // Fail closed on every Python-only line separator before locating byte boundaries.
  // eslint-disable-next-line no-control-regex
  if (/[\v\f\x1c-\x1e\x85\u2028\u2029]|\r(?!\n)/.test(text)) return yield* failure("Cannot safely edit unsupported line separators.");
  const result: Boundary[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let inComment = false;

  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = line.replace(/[\r\n]+$/, "");
    const markers = [...body.matchAll(/<!--|-->/g)];

    // eslint-disable-next-line no-control-regex
    if (/^[\p{White_Space}\x1c-\x1f]*#{1,6}/u.test(body) && (inComment || markers.length)) return yield* failure("Cannot safely edit comment-contained headings.");

    for (const marker of markers) {
      const opening = marker[0] === "<!--";

      if (opening === inComment) return yield* failure("Cannot safely edit ambiguous comments.");
      inComment = opening;
    }

    // eslint-disable-next-line no-control-regex
    if (/^[\p{White_Space}\x1c-\x1f]*(?:`{3,}|~{3,})/u.test(body)) return yield* failure("Cannot safely edit a profile containing fences.");

    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(body)) {
      // eslint-disable-next-line no-control-regex
      const normalizedHeading = strip(body).replace(/[\p{White_Space}\x1c-\x1f]+#+[\p{White_Space}\x1c-\x1f]*$/u, "");

      if (sections.some((heading) => heading === normalizedHeading) && !sections.some((heading) => heading === body)) return yield* failure("Cannot safely edit ambiguous headings.");

      if (sections.some((heading) => heading === body)) { if (seen.has(body)) return yield* failure("Cannot safely edit duplicate headings."); seen.add(body); }

      result.push({ heading: body, start: offset, bodyStart: offset + new TextEncoder().encode(line).length });
    } else if (/^[ \t]*(?:#|[=-]+[ \t]*$)/.test(body)) return yield* failure("Cannot safely edit ambiguous headings.");
    offset += new TextEncoder().encode(line).length;
  }

  if (inComment) return yield* failure("Cannot safely edit an unclosed comment.");
  const visible = text.replace(/<!--[\s\S]*?-->/g, "");

  // eslint-disable-next-line no-control-regex
  if (/<(?:\/?[A-Za-z][A-Za-z0-9:-]*(?:[\p{White_Space}\x1c-\x1f]|\/?>|$)|[!?])/u.test(visible)) return yield* failure("Cannot safely edit a profile containing raw HTML.");

  for (const body of visible.split(/\r?\n/)) {
    if (strip(body) && /^[ \t]/.test(body)) return yield* failure("Cannot safely edit indented Markdown.");

    if (body.startsWith(">") || /^(?:[-+*]|[0-9]+[.)])[ \t]+(?:#|>|`{3,}|~{3,}|(?:[-+*]|[0-9]+[.)])(?:[ \t]|$))/.test(body)) return yield* failure("Cannot safely edit Markdown containers.");
  }

  return result;
});

export const adjustableSections = (original: Uint8Array): Either.Either<readonly string[], ProfileError> => Either.map(boundaries(original), (items) => items.flatMap((item) => sections.slice(1).some((heading) => heading === item.heading) ? [item.heading] : []));

export const replaceSection = (original: Uint8Array, heading: string, replacement: string): Either.Either<Uint8Array, ProfileError> => Either.gen(function* () {
  const items = yield* boundaries(original);

  if (!sections.slice(1).some((section) => section === heading)) return yield* failure("Unknown section.");
  const index = items.findIndex((item) => item.heading === heading);
  const item = items[index];

  if (!item) return yield* failure("Section is not safely editable.");

  if (/[\uD800-\uDFFF]/u.test(replacement)) return yield* failure("Cannot safely encode this replacement.");
  const replacementBoundaries = yield* boundaries(new TextEncoder().encode(replacement));

  if (replacementBoundaries.length) return yield* failure("Replacement must not contain headings.");
  const end = items[index + 1]?.start ?? original.length;
  const newline = original[item.bodyStart - 2] === 13 && original[item.bodyStart - 1] === 10 ? "\r\n" : "\n";
  let value = replacement.replaceAll("\r\n", "\n").replace(/^\n+|\n+$/g, "").replaceAll("\n", newline);

  if (value) {
    if (item.bodyStart === original.length && original[item.bodyStart - 1] !== 10) value = newline + value;

    if (end < original.length || original[original.length - 1] === 10) value += newline;
  }

  const encoded = new TextEncoder().encode(value);
  const output = new Uint8Array(item.bodyStart + encoded.length + original.length - end);
  output.set(original.subarray(0, item.bodyStart)); output.set(encoded, item.bodyStart); output.set(original.subarray(end), item.bodyStart + encoded.length);

  return output;
});
