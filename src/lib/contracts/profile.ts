import { Schema } from "effect";
import { finiteNumber, nonemptyText } from "./support.ts";

export const PROFILE_TEXT_MAX_BYTES = 100_000;

export const ProfileId = Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.maxLength(64));
export const Cadence = Schema.Struct({ kind: Schema.Literal("weekly", "fortnightly"), anchor: Schema.NullOr(Schema.String) });

export const ProfilePaths = Schema.Struct({
  profile_id: ProfileId, directory: nonemptyText, profile_file: nonemptyText,
  narrative_file: nonemptyText, preferences_file: nonemptyText, source_db: nonemptyText,
  review_db: nonemptyText, ledger_db: nonemptyText, outbox_dir: nonemptyText,
});

// Frozen Python's existing unversioned dataclass boundary. Do not add a header or settings keys.
export const ProfileBundle = Schema.Struct({
  profile_id: ProfileId,
  paths: ProfilePaths,
  policy: Schema.Struct({
    mode: Schema.Literal("passive", "active"), max_recommendations: Schema.Literal(120), exceptional_only: Schema.Boolean,
    market_only: Schema.Boolean, freshness_max_age: Schema.Struct({ $seconds: finiteNumber.pipe(Schema.greaterThan(0)) }),
    timezone: Schema.Literal("Europe/Oslo"), cadence: Cadence,
  }),
  default_reviewer: Schema.NullOr(nonemptyText), full_review_batch_size: Schema.Int.pipe(Schema.between(1, 10)),
});

export type ProfileBundle = typeof ProfileBundle.Type;

export type ProfilePaths = typeof ProfilePaths.Type;

export type Cadence = typeof Cadence.Type;

export const ProfileStatus = Schema.Struct({
  profile_id: ProfileId, readiness: Schema.Literal("ready", "not-ready"), readiness_reason: Schema.NullOr(Schema.String),
  mode: Schema.Literal("passive", "active"), max_recommendations: Schema.Literal(120), exceptional_only: Schema.Boolean,
  market_only: Schema.Boolean, freshness_max_age_hours: finiteNumber.pipe(Schema.greaterThan(0)), timezone: Schema.Literal("Europe/Oslo"),
  cadence: Schema.Literal("weekly", "fortnightly"), cadence_anchor: Schema.NullOr(Schema.String),
  paths: Schema.Struct({ profile_config: nonemptyText, narrative: nonemptyText, preferences: nonemptyText, source_db: nonemptyText, review_db: nonemptyText, ledger_db: nonemptyText, outbox: nonemptyText }),
});

export type ProfileStatus = typeof ProfileStatus.Type;
