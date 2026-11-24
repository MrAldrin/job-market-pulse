import { Option } from "effect";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { codepointOrder } from "../shared/python-json.ts";

export type SelectMode = "passive" | "active";

// Internal projection supplied by a future saved-review adapter, not a wire contract.
export interface SavedCandidate {
  readonly listing_id: string;
  readonly lifecycle_status: string;
  readonly full_review: { readonly fit?: string; readonly reason?: string } | null;
  readonly title: string;
  readonly employer: string;
  readonly application_due: string | null;
  readonly expires_at: string | null;
  readonly source_version: string | null;
}

export const shortlistRule = (mode: SelectMode): string =>
  `${mode === "passive" ? "exceptional" : "exceptional and strong"}; open; exceptional first, then newest first`;

// CPython timedelta.total_seconds() divides integer microseconds by 1e6
// with one correctly rounded nearest-even float conversion. Convert the ratio
// directly: rounding the bigint first can merge distinct supported timestamps.
// Parsed datetime/offset bounds keep the result normal and finite.
const timestampSeconds = (micros: bigint): number => {
  if (micros === 0n) return 0;
  const negative = micros < 0n;
  const numerator = negative ? -micros : micros;
  const denominator = 1_000_000n;
  let exponent = numerator.toString(2).length - denominator.toString(2).length;

  if (exponent >= 0 ? numerator < (denominator << BigInt(exponent)) : (numerator << BigInt(-exponent)) < denominator) exponent--;
  const scaled = numerator << BigInt(52 - exponent);
  let significand = scaled / denominator;
  const remainder = scaled % denominator;

  if (2n * remainder > denominator || (2n * remainder === denominator && (significand & 1n) === 1n)) significand++;

  return (negative ? -1 : 1) * Number(significand) * 2 ** (exponent - 52);
};

export const selectShortlist = <Candidate extends SavedCandidate>(
  candidates: readonly Candidate[], firstFound: Readonly<Record<string, string>>, mode: SelectMode,
): readonly Candidate[] => {
  const found = (id: string): number | null => {
    const text = firstFound[id];

    if (text === undefined) return null;

    const parsed = parseIsoTime(text);

    return Option.isSome(parsed) && parsed.value.aware ? timestampSeconds(parsed.value.epochMicros) : null;
  };

  return candidates.filter((candidate) => {
    const fit = candidate.full_review?.fit;

    return !["application_deadline_passed", "source_expired", "confirmed_closed"].includes(candidate.lifecycle_status)
      && (fit === "exceptional" || (mode === "active" && fit === "strong"));
  }).sort((left, right) => {
    const fit = Number(left.full_review?.fit !== "exceptional") - Number(right.full_review?.fit !== "exceptional");

    if (fit) return fit;

    const a = found(left.listing_id);
    const b = found(right.listing_id);

    if (a === null && b !== null) return 1;

    if (a !== null && b === null) return -1;

    if (a !== null && b !== null && a !== b) return a > b ? -1 : 1;

    return codepointOrder(left.listing_id, right.listing_id);
  });
};
