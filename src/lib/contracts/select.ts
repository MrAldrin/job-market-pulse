import { Option, Predicate, Schema } from "effect";
import { parseIsoTime } from "./iso-time.ts";
import { integerToken } from "./support.ts";
import { strip } from "../server/shared/text.ts";

const plain = (maximum = 8000, newlines = false) => Schema.String.pipe(
  Schema.transform(Schema.String, { strict: true, decode: (value) => value.replace(/\r\n?/g, "\n"), encode: (value) => value }),
  Schema.filter((value) => strip(value).length > 0 && Array.from(value).length <= maximum
    && !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;

      return (code < 32 && !(newlines && code === 10)) || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    })),
);

const identifier = plain(128).pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/));
const fingerprint = plain(64).pipe(Schema.pattern(/^[0-9a-f]{64}$(?![\s\S])/));
const minimumTime = -62135596800000000n;
const maximumTime = 253402300799999999n;
export const DigestInstant = Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(minimumTime, maximumTime));

export const DigestTimestamp = Schema.String.pipe(
  Schema.filter((value) => Array.from(value).length <= 64 && Option.exists(parseIsoTime(value), (time) => time.aware && time.epochMicros >= minimumTime && time.epochMicros <= maximumTime)),
  Schema.transform(DigestInstant, { strict: true, decode: (value) => Option.getOrThrow(parseIsoTime(value)).epochMicros, encode: (value) => digestTimestamp(value) }),
);

export const digestTimestamp = (value: bigint): string => {
  const seconds = value / 1_000_000n - (value < 0n && value % 1_000_000n !== 0n ? 1n : 0n);
  const fraction = value - seconds * 1_000_000n;

  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + (fraction ? "." + String(fraction).padStart(6, "0") : "") + "+00:00";
};

// Match urlsplit's allowlist without WHATWG path normalization, default-port
// elision or rejection of the accepted empty port/query/fragment delimiters.
export const isDigestListingUrl = (value: string): boolean => {
  // urlsplit strips leading ASCII C0 controls and spaces, not Unicode whitespace.
  // eslint-disable-next-line no-control-regex
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?([^#]*))?(?:#(.*))?$(?![\s\S])/i.exec(value.replace(/^[\x00-\x20]+/, ""));

  return match !== null && /^(?:arbeidsplassen\.nav\.no)(?::)?$(?![\s\S])/i.test(match[1] ?? "")
    && /^\/stillinger\/stilling\/[A-Za-z0-9_-]{1,128}\/?$(?![\s\S])/.test(match[2] ?? "")
    && !(match[3] || match[4]) && !value.includes("\\");
};

export const DigestListingUrl = plain(512).pipe(Schema.filter(isDigestListingUrl));

const ConstraintStatus = Schema.Literal("pass", "fail", "unknown");

// Schema.Record decoding currently loses own __proto__ keys. Keep validated
// dynamic keys intact; the request's exact-name check must see every key.
type ConstraintMap = Readonly<Record<string, typeof ConstraintStatus.Type>>;

const HardConstraints = Schema.declare<ConstraintMap>((value): value is ConstraintMap =>
  Predicate.isRecord(value) && Object.values(value).every(Schema.is(ConstraintStatus)),
);

export const DigestCandidate = Schema.Struct({
  id: identifier, version: plain(128), title: plain(), employer: plain(), url: DigestListingUrl,
  fit: Schema.Literal("exceptional", "strong", "possible", "poor", "unknown"), reason: plain(),
  hard_constraints: HardConstraints,
  assessed_at: DigestTimestamp, expires_at: Schema.NullOr(DigestTimestamp),
  uncertainties: Schema.Array(plain(2000)).pipe(Schema.maxItems(50)),
}).pipe(Schema.filter((candidate) => candidate.expires_at === null || candidate.expires_at > candidate.assessed_at));

export type DigestCandidate = typeof DigestCandidate.Type & { readonly salary?: string };

export const DigestRequest = Schema.Struct({
  schema_version: Schema.compose(integerToken, Schema.Literal(1)),
  profile_id: plain(64).pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/)),
  profile_fingerprint: fingerprint,
  pack: Schema.optionalWith(Schema.NullOr(Schema.Struct({ id: identifier, fingerprint })), { default: () => null }),
  mode: Schema.Literal("passive", "active"),
  snapshot: Schema.Struct({ checked_at: DigestTimestamp, caught_up: Schema.Boolean }),
  assessments_complete: Schema.Boolean,
  hard_constraints: Schema.Array(identifier).pipe(Schema.maxItems(100)),
  candidates: Schema.Array(DigestCandidate).pipe(Schema.maxItems(500)),
  delivered: Schema.Array(Schema.Struct({ id: identifier, version: plain(128) })).pipe(Schema.maxItems(20000)),
  market_context: Schema.optionalWith(Schema.NullOr(plain(4000, true)), { default: () => null }),
  include_market_only: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}).pipe(Schema.filter((request) => new Set(request.hard_constraints).size === request.hard_constraints.length
  && new Set(request.candidates.map((candidate) => candidate.id)).size === request.candidates.length
  && new Set(request.delivered.map(({ id, version }) => JSON.stringify([id, version]))).size === request.delivered.length
  && request.candidates.every((candidate) => Object.keys(candidate.hard_constraints).length === request.hard_constraints.length
    && request.hard_constraints.every((name) => Object.hasOwn(candidate.hard_constraints, name)))));

export type DigestRequest = typeof DigestRequest.Type;

export interface Digest {
  readonly profile_id: string;
  readonly profile_fingerprint: string;
  readonly pack: DigestRequest["pack"];
  readonly as_of: bigint;
  readonly status: "blocked" | "quiet" | "ready";
  readonly blocked_reasons: readonly string[];
  readonly candidates: readonly DigestCandidate[];
  readonly market_context: string | null;
}
