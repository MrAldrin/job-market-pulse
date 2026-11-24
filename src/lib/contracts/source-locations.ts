import { Effect, Predicate, Schema } from "effect";
import type { SourceFailure } from "../server/source/errors.ts";
import { JsonInput, JsonObject } from "../server/shared/json-input.ts";

export const rejectionReasons = ["invalid_input", "no_unique_match", "address_mismatch", "postcode_mismatch", "unsupported_coordinate_system", "invalid_coordinates", "invalid_verification_flag"] as const;

export type AddressRejection = typeof rejectionReasons[number];

const count = Schema.Int.pipe(Schema.nonNegative());

export const AddressRejections = Schema.mutable(Schema.Struct({
  invalid_input: count, no_unique_match: count, address_mismatch: count, postcode_mismatch: count,
  unsupported_coordinate_system: count, invalid_coordinates: count, invalid_verification_flag: count,
}));

export const CoordinateVerificationCounts = Schema.mutable(Schema.Struct({ provider_true: count, provider_false: count, not_reported: count }));

export const AddressResolution = Schema.Struct({
  coordinates: Schema.Tuple(Schema.Number.pipe(Schema.finite(), Schema.between(-90, 90)), Schema.Number.pipe(Schema.finite(), Schema.between(-180, 180))),
  provider_stedfestingverifisert: Schema.NullOr(Schema.Boolean),
});

export type AddressResolution = typeof AddressResolution.Type;

type ResolveAddress = (address: JsonInput, postalCode: JsonInput) => Effect.Effect<AddressResolution | null, SourceFailure>;

const resolve = Schema.declare<ResolveAddress>((value): value is ResolveAddress => Predicate.isFunction(value));

export const AddressSession = Schema.mutable(Schema.Struct({
  requests: count, deadline: Schema.Number.pipe(Schema.finite()), rejections: AddressRejections,
  coordinate_verification_counts: CoordinateVerificationCounts, resolve,
}));

export type AddressSession = typeof AddressSession.Type;

export const LocationCandidate = Schema.Struct({ uuid: Schema.String });

export type LocationCandidate = typeof LocationCandidate.Type;

type Checkpoint = (uuid: string) => Effect.Effect<void, SourceFailure>;

export const ResolutionOptions = Schema.Struct({
  after: Schema.optional(Schema.String), now: Schema.optional(Schema.String),
  checkpoint: Schema.optional(Schema.declare<Checkpoint>((value): value is Checkpoint => Predicate.isFunction(value))),
});

export type ResolutionOptions = typeof ResolutionOptions.Type;

export const ResolutionResult = Schema.Struct({
  attempted: count, resolved: count, unknown: count, version_mismatch: count,
  unsupported_detail: count, last_uuid: Schema.NullOr(Schema.String),
});

export type ResolutionResult = typeof ResolutionResult.Type;

export const ResolutionInput = Schema.Struct({ candidates: Schema.Array(LocationCandidate), limit: Schema.Int.pipe(Schema.between(1, 10)), options: ResolutionOptions });

// Validate retained SQL values without dropping extra columns from the full-row CAS.
const locationAdRow = Schema.Struct({
  uuid: Schema.String, changed: Schema.String, first_seen: Schema.String, observed: Schema.String,
  title: Schema.String, employer: Schema.String, locations: Schema.String, topics: Schema.String,
  detail_missing: Schema.Int, expires: Schema.NullOr(Schema.String), source: Schema.NullOr(Schema.String),
}).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: JsonInput })));

export const LocationAdRow = Schema.declare<typeof locationAdRow.Type>(Schema.is(locationAdRow));

export const LocationVersionRow = Schema.Struct({ changed: Schema.String });
export const LocationDetailRow = Schema.Struct({ saved_changed: Schema.String, detail_changed: Schema.String });
export const StoredLocationRow = Schema.Struct({ points: Schema.String, provenance: Schema.String, incomplete: Schema.Int });

// External JSON integers remain bigint: 1.0 and true are not match counts.
export const OfficialAddressResponse = Schema.Struct({
  metadata: JsonObject, adresser: Schema.Array(JsonInput),
});

export const OfficialAddressMatchCount = Schema.BigIntFromSelf;
