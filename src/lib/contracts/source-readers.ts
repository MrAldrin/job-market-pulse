import { Schema } from "effect";
import { JsonInput } from "../server/shared/json-input.ts";

const adFields = {
  uuid: Schema.String, changed: Schema.String, first_seen: Schema.String, observed: Schema.String,
  title: Schema.String, employer: Schema.String, locations: Schema.String, topics: Schema.String,
  detail_missing: Schema.Int, expires: Schema.NullOr(Schema.String), source: Schema.NullOr(Schema.String),
};

// SELECT * readers retain additional columns from existing stores.
const sqliteValue = Schema.Union(Schema.Null, Schema.String, Schema.Number, Schema.BigIntFromSelf, Schema.Uint8ArrayFromSelf);

const adColumns = Schema.Record({ key: Schema.String, value: sqliteValue });

// These contracts have no transforms. Preserve own keys, including __proto__.
const ownRecord = <A>(value: Schema.Schema<A>) => {
  const record = Schema.Record({ key: Schema.String, value });

  return Schema.declare<typeof record.Type>(Schema.is(record));
};

const sourceAd = Schema.Struct(adFields).pipe(Schema.extend(adColumns));
export const SourceAd = Schema.declare<typeof sourceAd.Type>(Schema.is(sourceAd));

export type SourceAd = typeof SourceAd.Type;

// Generic current/historical lookups also support smaller caller-owned source tables.
const currentAdRow = Schema.Struct({
  uuid: Schema.String, changed: Schema.String,
  first_seen: Schema.optional(Schema.String), observed: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String), employer: Schema.optional(Schema.String),
  locations: Schema.optional(Schema.String), topics: Schema.optional(Schema.String),
  detail_missing: Schema.optional(Schema.Int), expires: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
}).pipe(Schema.extend(adColumns));

export const CurrentAdRow = Schema.declare<typeof currentAdRow.Type>(Schema.is(currentAdRow));

export type CurrentAdRow = typeof CurrentAdRow.Type;

export const OccupationPair = Schema.Tuple(Schema.String, Schema.String);

export type OccupationPair = typeof OccupationPair.Type;

export const DetailEvidence = Schema.Struct({ saved_changed: Schema.String, detail_changed: Schema.String });

export type DetailEvidence = typeof DetailEvidence.Type;

export const LocationEvidence = Schema.Struct({ points: Schema.String, incomplete: Schema.Int, provenance: Schema.String });

export type LocationEvidence = typeof LocationEvidence.Type;

export const CurrentAdEvidence = Schema.Struct({
  ad: Schema.NullOr(CurrentAdRow), version_exists: Schema.Boolean, version_changed: Schema.NullOr(Schema.String),
  detail_evidence: Schema.NullOr(DetailEvidence), has_location_points: Schema.Boolean,
  occupation_pairs: Schema.Array(OccupationPair), location_evidence: Schema.NullOr(LocationEvidence),
});

export type CurrentAdEvidence = typeof CurrentAdEvidence.Type;

export const LocationPoints = ownRecord(Schema.Tuple(Schema.Array(JsonInput), Schema.Boolean));

export type LocationPoints = typeof LocationPoints.Type;

export const RelevanceSourceSnapshot = Schema.Struct({ ads: Schema.Array(SourceAd), location_points: LocationPoints });

export type RelevanceSourceSnapshot = typeof RelevanceSourceSnapshot.Type;

export const ManifestSourceSnapshot = Schema.Struct({
  ...RelevanceSourceSnapshot.fields,
  state: ownRecord(Schema.String), listing_count: Schema.Int,
  occupation_pairs: ownRecord(Schema.Array(OccupationPair)),
  location_binding_digests: ownRecord(Schema.String),
});

export type ManifestSourceSnapshot = typeof ManifestSourceSnapshot.Type;

export const SourceStatus = Schema.Tuple(Schema.String, Schema.String);

export const ApplicationDeadline = Schema.Tuple(Schema.String, Schema.NullOr(Schema.String), Schema.Int);
