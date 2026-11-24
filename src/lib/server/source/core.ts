import { Either, Option, Predicate } from "effect";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { JsonObject, type JsonInput, parseJsonInput } from "../shared/json-input.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { collapseWhitespace, decimalText, normalized, strip } from "../shared/text.ts";
import { SourceError } from "./errors.ts";

export const ORIGIN = "https://pam-stilling-feed.nav.no";
export const MAX_DETAILS = 10;
export const MAX_FULL_TEXT_BYTES = 20_000;
export const rawObject = JsonObject;

export type SourceObject = typeof rawObject.Type;

export const asObject = (value: JsonInput | undefined): SourceObject | undefined =>
  Predicate.isRecord(value) && !Array.isArray(value) ? value : undefined;

export const text = (value: JsonInput | undefined): string => Predicate.isString(value) ? value : "";

export const truthy = (value: JsonInput | undefined): boolean => value !== undefined && value !== null
  && value !== false && value !== 0 && value !== 0n && value !== "" && (!Array.isArray(value) || value.length > 0)
  && (!Predicate.isRecord(value) || Object.keys(value).length > 0);

export const sourceJson = (value: string): Either.Either<JsonInput, SourceError> =>
  parseJsonInput(value).pipe(Either.mapLeft(() => new SourceError({ message: "NAV returned invalid JSON" })));

export const uuid = (value: string): Either.Either<string, SourceError> => {
  const hex = value.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^[{}]+|[{}]+$/g, "").replaceAll("-", "");

  const characters = Array.from(hex);

  // UUID(hex) checks Python scalar length before int(hex, 16), not ASCII shape.
  // ASCII U+001C..001F are str whitespace but are not accepted by Python int.
  if (characters.length !== 32 || characters.some((character) => {
    const point = character.codePointAt(0) ?? 0;

    return point >= 28 && point <= 31;
  })) return Either.left(new SourceError({ message: "Malformed UUID" }));
  const number = strip(decimalText(hex));

  if (!/^\+?(?:0[xX]_?)?[0-9a-fA-F](?:_?[0-9a-fA-F])*$/.test(number)) return Either.left(new SourceError({ message: "Malformed UUID" }));
  const integer = BigInt("0x" + number.replace(/^\+?(?:0[xX])?/, "").replaceAll("_", ""));

  if (integer < 0n || integer >= (1n << 128n)) return Either.left(new SourceError({ message: "Malformed UUID" }));
  const lower = integer.toString(16).padStart(32, "0");

  return Either.right([lower.slice(0, 8), lower.slice(8, 12), lower.slice(12, 16), lower.slice(16, 20), lower.slice(20)].join("-"));
};

// datetime.isoformat() keeps exactly six fractional digits when nonzero.
export const utcText = (micros: bigint, precision: "auto" | "seconds" | "microseconds" = "auto"): string => {
  const seconds = micros / 1_000_000n - (micros < 0n && micros % 1_000_000n !== 0n ? 1n : 0n);
  const fraction = micros - seconds * 1_000_000n;
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  const tail = precision === "microseconds" || (precision === "auto" && fraction !== 0n) ? "." + String(fraction).padStart(6, "0") : "";

  return base + tail + "+00:00";
};

export const timestamp = (value: JsonInput | undefined): Either.Either<string, SourceError> => {
  if (!Predicate.isString(value)) return Either.left(new SourceError({ message: "Missing NAV timestamp" }));

  const parsed = parseIsoTime(value);

  if (Option.isNone(parsed) || !parsed.value.aware) return Either.left(new SourceError({ message: "Invalid NAV timestamp" }));

  const micros = parsed.value.epochMicros;

  if (micros < -62_135_596_800_000_000n || micros >= 253_402_300_800_000_000n) return Either.left(new SourceError({ message: "Invalid NAV timestamp" }));

  return Either.right(utcText(micros));
};

export const instant = (value: string): Option.Option<bigint> =>
  Option.filterMap(parseIsoTime(value), (parsed) => parsed.aware ? Option.some(parsed.epochMicros) : Option.none());

export const apiUrl = (value: string, kind: "page" | "detail"): Either.Either<string, SourceError> => {
  // Python urlsplit removes leading C0 controls and embedded tab/CR/LF.
  // oxlint-disable-next-line no-control-regex
  const clean = value.replace(/^[\u0000-\u0020]+/u, "").replace(/[\t\r\n]/gu, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(clean);

  if (scheme && scheme[1]?.toLowerCase() !== "https") return Either.left(new SourceError({ message: "Rejected unexpected API destination" }));

  const supplied = scheme ? clean.slice(scheme[0].length) : clean;
  let absolute: string;

  if (supplied.startsWith("//")) absolute = "https:" + supplied;
  else {
    const pieces = /^([^?#]*)(\?[^#]*)?(#.*)?$/u.exec(supplied);
    const path = pieces?.[1] ?? "";
    const segments = path.startsWith("/") ? path.split("/") : ["", ...path.split("/").filter(Boolean)];
    const resolved: string[] = [];

    for (const segment of segments) {
      if (segment === "..") resolved.pop();
      else if (segment !== ".") resolved.push(segment);
    }

    if (path.endsWith("/.") || path.endsWith("/..") || path === "." || path === ".." || path.endsWith("/")) resolved.push("");
    const joined = resolved.join("/");
    absolute = ORIGIN + (joined.startsWith("/") ? joined : "/" + joined) + (pieces?.[2] ?? "") + (pieces?.[3] ?? "");
  }

  // Compare raw authority: URL canonicalization would erase ports and case.
  const split = /^(https):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(absolute);

  if (!split || split[2] !== "pam-stilling-feed.nav.no" || split[5]) return Either.left(new SourceError({ message: "Rejected unexpected API destination" }));

  const prefix = kind === "page" ? "/api/v1/feed" : "/api/v1/feedentry";
  const path = split[3] || "/";
  const query = split[4] ?? "";

  if (kind === "page" && path === prefix) {
    if (query !== "" && query !== "last") return Either.left(new SourceError({ message: "Rejected unexpected feed query" }));
  } else {
    if (!path.startsWith(prefix + "/") || query) return Either.left(new SourceError({ message: "Rejected unexpected API path" }));

    if (Either.isLeft(uuid(path.slice(prefix.length + 1)))) return Either.left(new SourceError({ message: "Rejected malformed API identifier" }));
  }

  return Either.right(ORIGIN + path + (query ? "?" + query : ""));
};

export const statuses = new Set(["ACTIVE", "INACTIVE", "STOPPED", "DELETED"]);

export const isRollingDeadline = (value: string): boolean =>
  new Set(["snarest", "snarest mulig", "fortløpende"]).has(normalized(value));

export const occupationRecords = (content: SourceObject): readonly (readonly string[])[] => {
  const rows: string[][] = [];
  const seen = new Set<string>();

  const add = (row: string[], valid: boolean) => {
    const key = JSON.stringify(row);

    if (valid && !seen.has(key)) { seen.add(key); rows.push(row); }
  };

  if (Array.isArray(content.occupationCategories)) {
    for (const value of content.occupationCategories) {
      const item = asObject(value);

      if (item) {
        const a = collapseWhitespace(text(item.level1));
        const b = collapseWhitespace(text(item.level2));
        add(["occupationCategories", a, b, "", ""], Boolean(a || b));
      }
    }
  }

  if (Array.isArray(content.categoryList)) {
    for (const value of content.categoryList) {
      const item = asObject(value);

      if (item) {
        const row = [text(item.categoryType), "", "", text(item.code), text(item.name)].map(collapseWhitespace);
        add(row, row.some(Boolean));
      }
    }
  }

  return rows;
};

export const locationLabels = (locations: readonly JsonInput[]): readonly string[] =>
  [...new Set(locations.flatMap((value) => {
    const item = asObject(value);
    const label = item ? text(item.municipal) || text(item.city) : "";

    return label ? [label] : [];
  }))].sort(codepointOrder);
