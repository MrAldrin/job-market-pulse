import { Schema } from "effect";

export const ObservationStatus = Schema.Literal("new", "changed", "previously_seen");

export type ObservationStatus = typeof ObservationStatus.Type;

export const Observation = Schema.Struct({
  listing_uuid: Schema.String,
  source_changed_at: Schema.String,
  first_seen_at: Schema.String,
  last_seen_at: Schema.String,
});

export type Observation = typeof Observation.Type;

export const ObservationRun = Schema.Struct({ run_id: Schema.Number.pipe(Schema.int(), Schema.positive()), started_at: Schema.String });

export type ObservationRun = typeof ObservationRun.Type;

export const RunObservation = Schema.Struct({
  run_id: Schema.Number.pipe(Schema.int(), Schema.positive()),
  listing_uuid: Schema.String,
  source_changed_at: Schema.String,
  observed_at: Schema.String,
  status: ObservationStatus,
});

export type RunObservation = typeof RunObservation.Type;
