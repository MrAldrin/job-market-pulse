import { Data, Either, Predicate, Schema } from "effect";
import { JsonInput, reviveJsonNumber } from "../shared/json-input.ts";
import { caseFold, collapseWhitespace, strip } from "../shared/text.ts";
import { nfkc151 } from "../shared/normalization.ts";

export type Point = readonly [number, number];

export type NormalizeName = (value: string) => string;

export const normalizeName: NormalizeName = (value) => collapseWhitespace(caseFold(nfkc151(value)));

export interface AreaExtent { readonly kommunenummer: JsonInput; readonly name: string; readonly hull: readonly Point[] }

export interface GeoAssessment { readonly status: "inside" | "outside" | "unknown"; readonly distance_km: number | null; readonly reason: string; readonly point_based: boolean }

export class GeographyError extends Data.TaggedError("GeographyError")<{ readonly message: string; readonly cause?: unknown }> {}

export const AREA_TOLERANCE_KM = 0.01;
export const NO_ORIGIN_REASON = "Official locality origin is not configured; not admitted inside radius.";
export const NO_EVIDENCE_REASON = "No approximate official workplace address points; no listed municipality is wholly inside the radius, so it is not admitted.";

// Coordinates arrive from untrusted JSON and must reject non-numeric values.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const point = (latitude: unknown, longitude: unknown): Point | null => Predicate.isNumber(latitude) && Predicate.isNumber(longitude) && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? [latitude, longitude] : null;

export const haversine = (origin: Point, target: Point): number => {
  const [lat1, lon1] = origin.map((value) => value * (Math.PI / 180));
  const [lat2, lon2] = target.map((value) => value * (Math.PI / 180));
  const a = Math.sin((lat2! - lat1!) / 2) ** 2 + Math.cos(lat1!) * Math.cos(lat2!) * Math.sin((lon2! - lon1!) / 2) ** 2;

  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
};

// Round the exact binary float to a decimal integer, ties to even (Python formatting).
const rounded = (value: number, decimalPlaces: number): bigint => {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value));
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  let numerator = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  let denominator = 1n;
  const binaryExponent = (exponent || 1) - 1075;

  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent); else denominator <<= BigInt(-binaryExponent);

  if (decimalPlaces >= 0) numerator *= 10n ** BigInt(decimalPlaces); else denominator *= 10n ** BigInt(-decimalPlaces);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  return quotient + (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n === 1n) ? 1n : 0n);
};

const fixed = (value: number, places: number): string => {
  const digits = rounded(value, places).toString().padStart(places + 1, "0");

  return (value < 0 || Object.is(value, -0) ? "-" : "") + (places ? digits.slice(0, -places) + "." + digits.slice(-places) : digits);
};

const general = (value: number): string => {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";

  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  let exponent = Math.floor(Math.log10(Math.abs(value)));
  let digits = rounded(value, 5 - exponent);

  if (digits >= 1000000n) { exponent++; digits = rounded(value, 5 - exponent); }

  const sign = value < 0 ? "-" : "";

  if (exponent < -4 || exponent >= 6) {
    const raw = digits.toString().padStart(6, "0");
    const fraction = raw.slice(1).replace(/0+$/, "");

    return sign + raw[0] + (fraction ? "." + fraction : "") + "e" + (exponent < 0 ? "-" : "+") + String(Math.abs(exponent)).padStart(2, "0");
  }

  const places = Math.max(0, 5 - exponent);

  return fixed(value, places).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

const assessment = (status: GeoAssessment["status"], distance_km: number | null, reason: string, point_based = false): GeoAssessment => ({ status, distance_km, reason, point_based });

export const assessGeography = (origin: Point | null, points: readonly Point[], radiusKm: number, incomplete = false): GeoAssessment => {
  if (origin === null) return assessment("unknown", null, NO_ORIGIN_REASON);

  if (!points.length) return assessment("unknown", null, NO_EVIDENCE_REASON);
  const distance = Math.min(...points.map((target) => haversine(origin, target)));

  if (distance <= radiusKm) return assessment("inside", distance, `At least one approximate official workplace address point is within ${general(radiusKm)} km straight-line of the configured locality origin; not a commute measurement.${incomplete ? " Other listed locations lack coordinates." : ""}`, true);

  if (incomplete) return assessment("unknown", distance, "Known workplace points are outside radius, but other locations lack coordinates; not admitted inside radius.", true);

  return assessment("outside", distance, `All approximate official workplace address points are outside the hard ${general(radiusKm)} km straight-line radius.`, true);
};

export const areaInsideRadius = (origin: Point, hull: readonly (readonly unknown[])[], radiusKm: number): number | null => {
  if (!hull.length) return null;
  const vertices = hull.map((vertex) => vertex.length === 2 ? point(vertex[0], vertex[1]) : null);

  if (vertices.some((vertex) => vertex === null)) return null;
  const bound = Math.max(...vertices.map((vertex) => haversine(origin, vertex!))) + AREA_TOLERANCE_KM;

  return bound <= radiusKm ? bound : null;
};

type ResourceObject = Readonly<Record<string, JsonInput>>;

// Predicate-only validation retains own/nested prototype-like JSON data keys.
const ResourceObject = Schema.declare<ResourceObject>((value): value is ResourceObject => Predicate.isRecord(value) && Schema.is(JsonInput)(value));

type ResourceIterable = readonly JsonInput[] | string | ResourceObject;

const ResourceIterable = Schema.declare<ResourceIterable>((value): value is ResourceIterable =>
  (Predicate.isString(value) || Array.isArray(value) || Predicate.isRecord(value)) && Schema.is(JsonInput)(value),
);

const resourceError = (cause: unknown) => new GeographyError({ message: "Malformed area extents", cause });

// Python iterates JSON strings and object keys too. Empty ones are valid empty
// collections; nonempty ones reach the same per-item validation as array entries.
const resourceItems = (value: JsonInput | undefined) => Schema.decodeUnknownEither(ResourceIterable)(value).pipe(
  Either.mapLeft(resourceError),
  Either.map((items): readonly JsonInput[] => Predicate.isString(items) ? [...items] : Array.isArray(items) ? items : Object.keys(items)),
);

export const decodeAreaExtents = (text: string, normalizeName: NormalizeName): Either.Either<ReadonlyMap<string, AreaExtent>, GeographyError> => Either.gen(function* () {
  // Deliberately last-wins: strict digest/review duplicate/depth/size policy
  // does not belong to this public resource. Only bare constants are hardened.
  const parsed = yield* Either.try({ try: () => {
    const raw: unknown = JSON.parse(text, reviveJsonNumber);

    return Schema.decodeUnknownEither(ResourceObject)(raw).pipe(Either.mapLeft(resourceError));
  }, catch: resourceError });

  const data = yield* parsed;
  // This public resource requires string collision labels, not Python str/repr coercion.
  const collisionNames = yield* Schema.decodeUnknownEither(Schema.Array(Schema.String))(data["name_collisions"]).pipe(Either.mapLeft(resourceError));
  const collisions = new Set(collisionNames.map(normalizeName));
  const items = yield* resourceItems(data["municipalities"]);
  const result = new Map<string, AreaExtent>();

  for (const rawItem of items) {
    const item = yield* Schema.decodeUnknownEither(ResourceObject)(rawItem).pipe(Either.mapLeft(resourceError));
    const name = yield* Schema.decodeUnknownEither(Schema.String)(item["name"]).pipe(Either.mapLeft(resourceError));
    const key = normalizeName(name);

    if (collisions.has(key)) continue;

    if (result.has(key)) return yield* Either.left(new GeographyError({ message: "Duplicate municipality name in area extents" }));
    const vertices = yield* resourceItems(item["hull"]);
    const hull: Point[] = [];

    for (const vertex of vertices) {
      if (!Array.isArray(vertex) || vertex.length !== 2) return yield* Either.left(new GeographyError({ message: "Malformed area extent vertex" }));
      // The shared JSON parser preserves integer tokens as bigint. Coordinates
      // become floats only here; opaque metadata keeps the original JSON value.
      const checked = point(Predicate.isBigInt(vertex[0]) ? Number(vertex[0]) : vertex[0], Predicate.isBigInt(vertex[1]) ? Number(vertex[1]) : vertex[1]);

      if (!checked) return yield* Either.left(new GeographyError({ message: "Invalid area extent vertex" }));
      hull.push(checked);
    }

    if (!Object.hasOwn(item, "kommunenummer")) return yield* Either.left(new GeographyError({ message: "Missing municipality number in area extents" }));
    result.set(key, { kommunenummer: item["kommunenummer"]!, name, hull });
  }

  return result;
});

export const assessAreaLabels = (origin: Point | null, labels: readonly unknown[], radiusKm: number, extents: ReadonlyMap<string, AreaExtent>, normalizeName: NormalizeName): GeoAssessment => {
  if (origin === null) return assessment("unknown", null, NO_ORIGIN_REASON);
  const inside: [string, number][] = [];

  for (const label of labels) {
    if (!Predicate.isString(label)) continue;
    const extent = extents.get(normalizeName(label));

    if (!extent) continue;
    const distance = areaInsideRadius(origin, extent.hull, radiusKm);

    if (distance !== null) inside.push([strip(label), distance]);
  }

  if (!inside.length) return assessment("unknown", null, NO_EVIDENCE_REASON);
  const names = inside.map(([name]) => name).join(", ");
  const distance = Math.min(...inside.map(([, value]) => value));

  if (inside.length === labels.length) {
    const plural = inside.length > 1;

    return assessment("inside", distance, `Whole municipalit${plural ? "ies" : "y"} (${names}) ${plural ? "lie" : "lies"} within ${general(radiusKm)} km straight-line of the locality origin; upper-bound distance ${fixed(distance, 1)} km; no street address resolved.`);
  }

  return assessment("inside", distance, `At least one whole municipality (${names}) lies within ${general(radiusKm)} km straight-line of the locality origin; upper-bound distance ${fixed(distance, 1)} km; no street address resolved. Other listed locations are not proven inside and are not used.`);
};

export const assessLocation = (origin: Point | null, points: readonly Point[], labels: readonly unknown[], radiusKm: number, incomplete: boolean, extents: ReadonlyMap<string, AreaExtent>, normalizeName: NormalizeName): GeoAssessment => points.length ? assessGeography(origin, points, radiusKm, incomplete) : assessAreaLabels(origin, labels, radiusKm, extents, normalizeName);
