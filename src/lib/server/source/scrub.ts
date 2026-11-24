import { Match } from "effect";
import { unescapeHtml } from "../shared/html.ts";
import { pythonDigitClass, pythonWordClass, strip } from "../shared/text.ts";

const spaces = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const d = pythonDigitClass;
const w = pythonWordClass;

const asciiCase = (value: string): string => Array.from(value, (letter) => Match.value(letter).pipe(
  Match.when("i", () => "[iIİı]"), Match.when("s", () => "[sSſ]"), Match.when("k", () => "[kKK]"),
  Match.orElse(() => `[${letter}${letter.toUpperCase()}]`),
)).join("");

const tags = /<[^>]{0,500}>/gu;
const url = new RegExp(`(?:${asciiCase("http")}${asciiCase("s")}?://|${asciiCase("www")}\\.)[^${spaces},"'<>]+`, "gu");
const email = new RegExp(`${w.slice(0, -1)}.+-]{1,64} ?(?:@|\\[${asciiCase("at")}\\]|\\(${asciiCase("at")}\\)) ?${w.slice(0, -1)}-]{1,63}(?:\\.${w.slice(0, -1)}-]{1,63}){1,8}`, "gu");
const abbreviations = ["kr", "pr", "nr", "ca", "kl", "evt", "inkl", "ekskl", "dvs", "mht", "osv", "tlf", "ref", "eks", "mill", "org"].map(asciiCase).join("|");
const domain = new RegExp(`(?<!${w.slice(0, -1)}@.\\-])(?!(?:${abbreviations})\\.)(?:[a-zA-ZİıſK0-9][a-zA-ZİıſK0-9-]{1,62}\\.){1,8}[a-z]{2,6}(?:/[^${spaces},"'<>]*)?(?!${w.slice(0, -1)}-])`, "gu");
const phone = new RegExp(`(?<!${d})(?<![+])(?<!${d}[ ./-])((?:\\+|00)47[ ./-]?)?(${d}{1,16}(?:[ ./-]${d}{1,16}){0,15})(?![ ./-]?${d})`, "gu");

const phonePlaceholder = (whole: string, prefix: string | undefined, body: string): string => {
  const pieces = body.split(/([ ./-])/u);
  const parts: { before: string; text: string; lengths: number[] }[] = [];
  let size = 8;

  for (let index = 0; index < pieces.length; index += 2) {
    const group = pieces[index] ?? "";

    if (size === 8) { parts.push({ before: index ? pieces[index - 1] ?? "" : "", text: "", lengths: [] }); size = 0; }

    const part = parts[parts.length - 1];

    if (!part) return whole;

    const length = Array.from(group).length;
    part.text += (part.lengths.length ? pieces[index - 1] ?? "" : "") + group;
    part.lengths.push(length);
    size += length;

    if (size > 8) return whole;
  }

  if (size !== 8) return whole;

  const rendered = parts.map((part) => part.before + (JSON.stringify(part.lengths) === "[2,2,4]" || JSON.stringify(part.lengths) === "[4,2,2]" ? part.text : "[telefon]"));

  return (prefix && rendered[0] === "[telefon]" ? "" : prefix ?? "") + rendered.join("");
};

// Keep anchor text; only minimized active-ingest copies use this scrubber.
export const scrubContactDetails = (input: string): string => {
  let value = unescapeHtml(input.replace(tags, " ")).replace(tags, " ");
  value = value.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, "");
  value = strip(value.replace(new RegExp(`[${spaces.replace("\\u0009-\\u000d", "\\u0009\\u000b-\\u000d")}]+`, "gu"), " "));
  value = value.replace(url, "[lenke]").replace(email, "[e-post]").replace(domain, "[lenke]");

  return value.replace(phone, phonePlaceholder);
};
