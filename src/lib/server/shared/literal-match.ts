import lowerData from "../../../../resources/profile/unicode-simple-lower-15.1.json";
import extraData from "../../../../resources/profile/python-re-extra-cases-3.13.11.json";
import { pythonWordClass } from "./text.ts";

const lower = new Map(Object.entries(lowerData).map(([point, value]) => [Number(point), value]));
const extra = new Map(Object.entries(extraData).map(([point, values]) => [Number(point), values]));
const word = new RegExp("^" + pythonWordClass + "$", "u");
const originals = new Map<number, number[]>();

for (const [point, mapped] of lower) {
  const values = originals.get(mapped) ?? [];
  values.push(point);
  originals.set(mapped, values);
}

const simpleCaseVariants = (point: number): readonly number[] => {
  const mapped = lower.get(point) ?? point;
  const variants = new Set([mapped, ...(extra.get(mapped) ?? [])]);
  const matches = new Set<number>(variants);

  for (const variant of variants) for (const original of originals.get(variant) ?? []) matches.add(original);

  return [...matches];
};

// Escape fixed Pulse literal terms as data, never as regex grammar.
// User-selected Screen patterns use native RegExp directly.
export const literalSource = (text: string): string => Array.from(text, (character) =>
  "[" + simpleCaseVariants(character.codePointAt(0) ?? -1).map((value) => "\\u{" + value.toString(16) + "}").join("") + "]",
).join("");

export const isPythonWord = (character: string | undefined): boolean => character !== undefined && word.test(character);

// CPython's escaped-literal re.I comparison: simple lowercase plus _EXTRA_CASES.
// Full C/F caseFold is deliberately NOT used: ß must not become two letters.
export const simpleCaseEqual = (left: string, right: string): boolean => {
  const leftPoint = left.codePointAt(0) ?? -1;
  const rightPoint = right.codePointAt(0) ?? -1;
  const a = lower.get(leftPoint) ?? leftPoint;
  const b = lower.get(rightPoint) ?? rightPoint;

  return a === b || (extra.get(a)?.includes(b) ?? false);
};

export const literalAt = (text: readonly string[], phrase: readonly string[], index: number): boolean =>
  phrase.every((character, offset) => {
    const actual = text[index + offset];

    return actual !== undefined && simpleCaseEqual(character, actual);
  });

// Retained matches() always uses (?<!\\w) and (?!\\w), including literals
// that begin or end with punctuation. This is not JavaScript's ASCII \\b.
export const containsLiteral = (text: string, phrase: string): boolean => {
  const haystack = Array.from(text);
  const needle = Array.from(phrase);

  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (isPythonWord(haystack[index - 1])) continue;

    if (isPythonWord(haystack[index + needle.length])) continue;

    if (literalAt(haystack, needle, index)) return true;
  }

  return false;
};
