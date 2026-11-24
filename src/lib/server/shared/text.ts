import { Predicate } from "effect";
import casefold from "../../../../resources/profile/unicode-casefold-15.1.json";
import properties from "../../../../resources/profile/unicode-properties-15.1.json";
import rejectedText from "../../../../resources/profile/unicode-rejected-text-15.1.json";
import { pythonSpace } from "../../text-whitespace.ts";
import { decimalDigit, inRanges } from "../../unicode-characters.ts";

export { pythonSpaceClass, strip } from "../../text-whitespace.ts";

export { decimalDigit } from "../../unicode-characters.ts";

// Unicode 15.1 full C/F casefold mappings, matching the frozen CPython 3.13 data.
// Source: https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt (Unicode license).
const fold = new Map(Object.entries(casefold));
export const caseFold = (value: string): string => Array.from(value, (character) => fold.get(character) ?? character).join("");

export const words = (value: string): readonly string[] => {
  const words: string[] = [];
  let word = "";

  for (const character of value) {
    if (pythonSpace(character)) {
      if (word) words.push(word);
      word = "";
    } else word += character;
  }

  if (word) words.push(word);

  return words;
};

export const collapseWhitespace = (value: string): string => words(value).join(" ");
export const normalized = (value: string): string => caseFold(collapseWhitespace(value));

const rangePattern = (ranges: readonly (readonly number[])[]): string => ranges.map(([start = 0, end = start]) =>
  "\\u{" + start.toString(16) + "}" + (end === start ? "" : "-\\u{" + end.toString(16) + "}"),
).join("");

const alphanumericPattern = rangePattern(properties.alphanumeric);
export const pythonAlnumClass = "[" + alphanumericPattern + "]";
export const pythonWordClass = "[" + alphanumericPattern + "_]";
export const pythonDigitClass = "[" + rangePattern(properties.decimal) + "]";

export const decimalText = (value: string): string => Array.from(value, (character) => {
  if (!decimalDigit(character)) return character;

  const point = character.codePointAt(0) ?? 0;
  let zero = point;

  while (zero > 0 && decimalDigit(String.fromCodePoint(zero - 1))) zero--;

  return String((point - zero) % 10);
}).join("");

export const printable = (value: string): boolean => Array.from(value).every((character) => inRanges(properties.printable, character.codePointAt(0) ?? -1));
export const hasRejectedTextCharacter = (value: string): boolean => Array.from(value).some((character) => inRanges(rejectedText, character.codePointAt(0) ?? -1));
export const isRecord = Predicate.isRecord;
