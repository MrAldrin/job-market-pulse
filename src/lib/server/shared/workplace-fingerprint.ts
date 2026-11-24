import { Either, Option, Predicate, Schema } from "effect";
import { decodeStrict } from "../../contracts/support.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { JsonObject, type JsonInput, parseJsonInput } from "./json-input.ts";
import { decimalDigit, normalized, strip } from "./text.ts";
import { PythonFloat, type PythonJson, pythonJson, sha256 } from "./python-json.ts";

export const FINGERPRINT_VERSION = 1;
export const POINT_DIGEST_VERSION = 1;
export const SUPPORTED_PROVIDER = "https://ws.geonorge.no/adresser/v1/sok";
export const SUPPORTED_METHOD = "exact_unique_address_postcode_epsg4326_approximate";
export const norwegianCountries = new Set(["NORGE", "Norge", "Norway", "NORWAY", "NO"]);
const rawObject = JsonObject;
const stringInput = Schema.is(Schema.String);

export const validAddressText = (address: JsonInput): boolean => stringInput(address)
  && Array.from(address).length >= 1 && Array.from(address).length <= 300
  && !Array.from(address).some((character) => (character.codePointAt(0) ?? 0) < 32) && Array.from(address).some(decimalDigit);

export const validPostalCode = (code: JsonInput): boolean => stringInput(code) && /^[0-9]{4}$/.test(code);

const sourceJson = (value: JsonInput): PythonJson => {
  if (Predicate.isNumber(value)) {
    if (Number.isFinite(value)) return new PythonFloat(value);

    return { type: "number", value: Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf" };
  }

  if (Array.isArray(value)) return value.map(sourceJson);

  if (Predicate.isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sourceJson(item)]));

  return value;
};

const field = (location: Readonly<Record<string, JsonInput>>, name: string, kind: "address" | "postal_code" | "country"): PythonJson => {
  if (!Object.hasOwn(location, name)) return { state: "omitted" };

  const value = location[name] ?? null;

  if (value === null) return { state: "null" };

  if (stringInput(value)) {
    if (!strip(value)) return { state: "blank" };

    if (kind === "address" && validAddressText(value)) return { state: "valid", value: normalized(value) };

    if (kind === "postal_code" && validPostalCode(value)) return { state: "valid", value };

    if (kind === "country") return norwegianCountries.has(value) ? { state: "norwegian" } : { state: "foreign", value };
  }

  return { state: "invalid", value: sourceJson(value) };
};

export const fingerprintWorkLocations = (content: Readonly<Record<string, JsonInput>>): string => {
  let locations: PythonJson;

  if (!Object.hasOwn(content, "workLocations")) locations = { state: "omitted" };
  else {
    const value = content.workLocations ?? null;

    if (value === null) locations = { state: "null" };
    else if (!Array.isArray(value)) locations = { state: "invalid", value: sourceJson(value) };
    else {
      const items = value.map((item): PythonJson => {
        const decoded = decodeStrict(rawObject)(item);

        return Either.isLeft(decoded) ? { state: "invalid_location", value: sourceJson(item) } : {
          state: "location", address: field(decoded.right, "address", "address"),
          postal_code: field(decoded.right, "postalCode", "postal_code"), country: field(decoded.right, "country", "country"),
        };
      });

      items.sort((left, right) => {
        const a = pythonJson(left);
        const b = pythonJson(right);

        return a < b ? -1 : a === b ? 0 : 1;
      });
      locations = { state: "list", items };
    }
  }

  return sha256(pythonJson({ version: 1, work_locations: locations }));
};

export const pointPayloadJson = (points: readonly (readonly [number, number])[]): string =>
  "[" + points.map(([latitude, longitude]) => `[${pythonJson(new PythonFloat(latitude))}, ${pythonJson(new PythonFloat(longitude))}]`).join(", ") + "]";

export const pointPayloadDigest = sha256;

export interface WorkplaceBindingInput {
  readonly digest: string;
  readonly pointsJson: string;
  readonly uuid: string;
  readonly sourceVersion: string;
  readonly detailChanged: string;
  readonly detailSavedChanged: string | null;
  readonly incomplete: boolean;
}

export const workplaceBinding = (input: WorkplaceBindingInput) => ({
  version: 1, sha256: input.digest, point_digest_version: 1, points_sha256: sha256(input.pointsJson), uuid: input.uuid,
  source_version: input.sourceVersion, detail_version_source: input.detailSavedChanged === null ? "source_changed_fallback" : "ad_detail_versions",
  detail_changed: input.detailChanged, detail_saved_changed: input.detailSavedChanged, incomplete: input.incomplete,
});

const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));

const Binding = Schema.Struct({
  version: Schema.Literal(1n), sha256: digest, point_digest_version: Schema.Literal(1n), points_sha256: digest,
  uuid: Schema.String, source_version: Schema.String, detail_version_source: Schema.Literal("source_changed_fallback", "ad_detail_versions"),
  detail_changed: Schema.String, detail_saved_changed: Schema.NullOr(Schema.String), incomplete: Schema.Literal(false),
});

const Provenance = Schema.Struct({
  provider: Schema.Literal(SUPPORTED_PROVIDER), method: Schema.Literal(SUPPORTED_METHOD), source_version: Schema.String,
  retrieved_at: Schema.String, provider_stedfestingverifisert: Schema.Array(Schema.NullOr(Schema.Boolean)), workplace_fingerprint: Binding,
});

const coordinate = Schema.Union(Schema.Number.pipe(Schema.finite()), Schema.transform(Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(-180n, 180n)), Schema.Number, { strict: true, decode: Number, encode: BigInt }));
const Points = Schema.Array(Schema.Tuple(coordinate.pipe(Schema.between(-90, 90)), coordinate.pipe(Schema.between(-180, 180)))).pipe(Schema.minItems(1));

export interface WorkplaceEvidenceInput {
  readonly provenance: string;
  readonly uuid: string;
  readonly sourceVersion: string;
  readonly versionChanged: string | null;
  readonly incomplete: boolean | number;
  readonly pointsJson: string;
  readonly currentDetailEvidence?: Readonly<Record<string, JsonInput>>;
  readonly currentDetailContent?: Readonly<Record<string, JsonInput>>;
}

export interface VerifiedWorkplaceEvidence {
  readonly geography_digest: string;
  readonly workplace_digest: string;
  readonly points_digest: string;
  readonly point_count: number;
  readonly uuid: string;
  readonly source_version: string;
  readonly detail_changed: string;
}

// Resolver provenance uses canonical UTC from datetime.isoformat(), not an arbitrary aware spelling.
const canonicalUtc = (value: string): boolean => /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{6})?\+00:00$/.test(value)
  && !value.includes(".000000+") && Option.exists(parseIsoTime(value), (time) => time.aware);

const uuidHex = Schema.is(Schema.String.pipe(Schema.length(32), Schema.pattern(/^[0-9a-fA-F]{32}$/)));
const uuid = (value: string): boolean => uuidHex(value.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^[{}]+|[{}]+$/g, "").replaceAll("-", ""));

const completeInputs = (content: Readonly<Record<string, JsonInput>>, count: number): boolean => {
  const locations = content.workLocations;

  return Array.isArray(locations) && locations.length > 0 && locations.length <= 100 && locations.length === count && locations.every((value) => {
    const row = decodeStrict(rawObject)(value);

    return Either.isRight(row) && validAddressText(row.right.address ?? null) && validPostalCode(row.right.postalCode ?? null)
      && stringInput(row.right.country) && norwegianCountries.has(row.right.country);
  });
};

export const verifyWorkplaceEvidence = (input: WorkplaceEvidenceInput): Option.Option<VerifiedWorkplaceEvidence> => {
  if (!canonicalUtc(input.sourceVersion) || input.versionChanged !== input.sourceVersion || !uuid(input.uuid)
      || (input.incomplete !== false && input.incomplete !== 0)) return Option.none();

  const points = Either.flatMap(parseJsonInput(input.pointsJson), (raw) => Either.mapLeft(decodeStrict(Points)(raw), () => "Invalid points"));
  const decoded = Either.flatMap(parseJsonInput(input.provenance), (raw) => Either.mapLeft(decodeStrict(Provenance)(raw), () => "Invalid provenance"));

  if (Either.isLeft(points) || Either.isLeft(decoded)) return Option.none();

  const data = decoded.right;
  const binding = data.workplace_fingerprint;

  if (data.source_version !== input.sourceVersion || !canonicalUtc(data.retrieved_at)
    || data.provider_stedfestingverifisert.length !== points.right.length || binding.points_sha256 !== sha256(input.pointsJson)
    || binding.uuid !== input.uuid || binding.source_version !== input.sourceVersion || !canonicalUtc(binding.detail_changed)) return Option.none();

  if (binding.detail_version_source === "ad_detail_versions") {
    if (input.currentDetailEvidence === undefined || binding.detail_saved_changed !== input.sourceVersion
      || input.currentDetailEvidence.saved_changed !== input.sourceVersion || input.currentDetailEvidence.detail_changed !== binding.detail_changed) return Option.none();
  } else if (binding.detail_saved_changed !== null || input.currentDetailEvidence !== undefined || binding.detail_changed !== input.sourceVersion) return Option.none();

  if (input.currentDetailContent !== undefined && (!completeInputs(input.currentDetailContent, points.right.length)
    || fingerprintWorkLocations(input.currentDetailContent) !== binding.sha256)) return Option.none();

  return Option.some({ geography_digest: sha256(pythonJson(data)), workplace_digest: binding.sha256,
    points_digest: binding.points_sha256, point_count: points.right.length, uuid: input.uuid,
    source_version: input.sourceVersion, detail_changed: binding.detail_changed });
};

export const hasCurrentWorkplaceBinding = (input: Omit<WorkplaceEvidenceInput, "versionChanged">): boolean =>
  Option.isSome(verifyWorkplaceEvidence({ ...input, versionChanged: input.sourceVersion }));
