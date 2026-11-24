import entities from "../../../../resources/html/entities.json";

const names: Readonly<Record<string, string>> = entities;

const invalidReferences = new Map<number, string>(Object.entries({
  0: "\ufffd", 13: "\r", 128: "\u20ac", 129: "\x81", 130: "\u201a", 131: "\u0192", 132: "\u201e",
  133: "\u2026", 134: "\u2020", 135: "\u2021", 136: "\u02c6", 137: "\u2030", 138: "\u0160",
  139: "\u2039", 140: "\u0152", 141: "\x8d", 142: "\u017d", 143: "\x8f", 144: "\x90",
  145: "\u2018", 146: "\u2019", 147: "\u201c", 148: "\u201d", 149: "\u2022", 150: "\u2013",
  151: "\u2014", 152: "\u02dc", 153: "\u2122", 154: "\u0161", 155: "\u203a", 156: "\u0153",
  157: "\x9d", 158: "\u017e", 159: "\u0178",
}).map(([code, text]) => [Number(code), text]));

const reference = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

// CPython 3.13.11 html.unescape rules and its complete public HTML5 table.
export const unescapeHtml = (value: string): string => value.replace(reference, (_match, token: string) => {
  if (token.startsWith("#")) {
    const code = token[1] === "x" || token[1] === "X" ? parseInt(token.slice(2), 16) : parseInt(token.slice(1), 10);

    if (invalidReferences.has(code)) return invalidReferences.get(code) ?? "";

    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";

    if ((code >= 1 && code <= 8) || code === 11 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
      || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xffff) >= 0xfffe) return "";

    return String.fromCodePoint(code);
  }

  if (Object.hasOwn(names, token)) return names[token] ?? "";

  for (let length = Array.from(token).length - 1; length > 1; length--) {
    const chars = Array.from(token);
    const prefix = chars.slice(0, length).join("");

    if (Object.hasOwn(names, prefix)) return (names[prefix] ?? "") + chars.slice(length).join("");
  }

  return "&" + token;
});
