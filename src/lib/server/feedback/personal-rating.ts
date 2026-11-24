import { Clock, Effect, Either, Schema } from "effect";
import { Identity, ProfileId } from "../../contracts/judge-state.ts";
import { isoInstant } from "../judge/core.ts";
import type { JudgeDatabaseHandle } from "../judge/database.ts";
import { strip } from "../shared/text.ts";
import { createPersonalRatingSchema, personalRatingSchema, ratingError, refuseTempRatingConflicts } from "./personal-rating-schema.ts";

const Rating = Schema.Literal("very_good", "good", "unsure", "bad", "very_bad");
const Source = Schema.Literal("nav");
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const RatingInput = Schema.Struct({
  profile_id: ProfileId,
  ad_id: Schema.String,
  source: Schema.optional(Schema.String),
  source_version: Schema.String,
  rating: Rating,
  reason: Schema.optional(Schema.String),
  result_id: Schema.optional(Schema.NullOr(Schema.Union(Schema.String,
    Schema.Number.pipe(Schema.filter(Number.isSafeInteger)), Schema.BigIntFromSelf))),
  input_fingerprint: OptionalText,
  profile_fingerprint: OptionalText,
  preferences_fingerprint: OptionalText,
  rules_fingerprint: OptionalText,
  scoring_version: OptionalText,
  review_prompt_version: OptionalText,
});

export type PersonalRatingInput = typeof RatingInput.Type;

const EventRow = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^-?(?:0|[1-9][0-9]*)(?![\s\S])/)),
  ad_id: Schema.String,
  source: Source,
  source_version: Schema.String,
  rating: Rating,
  reason: Schema.String,
  created_at: Schema.String,
  result_id: Schema.NullOr(Schema.String),
});

// SQLite INTEGER identities cross the driver boundary as decimal text, not doubles.
export type PersonalRatingEventRow = typeof EventRow.Type;

const EventRows = Schema.Array(EventRow);

// Frozen feedback-events export probes one extra row so overflow never silently truncates history.
const maxRatingEvents = 50_000;

const decode = <A, I>(schema: Schema.Schema<A, I>, value: I) => Either.mapLeft(
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value),
  () => ratingError("Invalid personal rating input or stored row"),
);

const selectedProfile = (state: JudgeDatabaseHandle, profileId: string) =>
  Schema.is(ProfileId)(profileId) && state.profile_id === profileId
    ? Effect.void : Effect.fail(ratingError("Profile ID does not match selected state"));

const checkOwner = (state: JudgeDatabaseHandle) => Effect.gen(function* () {
  if (!state.initialized) return yield* ratingError("Selected personal state is not initialized");

  const rows = yield* state.sql<{ profile_id: string | null }>`SELECT profile_id FROM main.personal_state_profile LIMIT 2`;

  if (rows.length !== 1 || rows[0]?.profile_id !== state.profile_id) {
    return yield* ratingError("Personal state ownership does not match the selected profile");
  }
});

const text = (value: string, maximum: number, allowEmpty = false) => {
  const trimmed = strip(value);

  return Array.from(value).length <= maximum && (allowEmpty || trimmed.length > 0)
    && Array.from(trimmed).every((char) => char.charCodeAt(0) >= 32)
    ? Either.right(trimmed) : Either.left(ratingError("Invalid personal rating text"));
};

const optionalText = (value: string | null | undefined) => value == null ? Either.right(null) : text(value, 128);

const canonicalAd = (value: string) => {
  const hex = value.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^[{}]+|[{}]+$/g, "").replaceAll("-", "").toLowerCase();
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  return Schema.is(Identity)(id) ? Either.right(id) : Either.left(ratingError("NAV ad ID must be a UUID"));
};

const resultId = (value: PersonalRatingInput["result_id"]) => {
  if (value == null || Schema.is(Schema.String)(value)) return optionalText(value);

  return value > 0 ? optionalText(String(value)) : Either.left(ratingError("Invalid review result ID"));
};

export const appendPersonalRating = (state: JudgeDatabaseHandle, input: PersonalRatingInput) => Effect.gen(function* () {
  const rating = yield* decode(RatingInput, input);
  yield* selectedProfile(state, rating.profile_id);

  if (state.readonly) return yield* ratingError("Personal state is read-only");

  const ad = yield* canonicalAd(rating.ad_id);
  const source = (yield* text(rating.source ?? "nav", 40)).toLowerCase();

  if (source !== "nav") return yield* ratingError("Only NAV listings are supported");

  const sourceVersion = yield* text(rating.source_version, 128);
  const reason = yield* text(rating.reason ?? "", 500, true);
  const result = yield* resultId(rating.result_id);
  const inputFingerprint = yield* optionalText(rating.input_fingerprint);
  const profileFingerprint = yield* optionalText(rating.profile_fingerprint);
  const preferencesFingerprint = yield* optionalText(rating.preferences_fingerprint);
  const rulesFingerprint = yield* optionalText(rating.rules_fingerprint);
  const scoringVersion = yield* optionalText(rating.scoring_version);
  const promptVersion = yield* optionalText(rating.review_prompt_version);
  const now = yield* Clock.currentTimeNanos;
  const createdAt = yield* Either.mapLeft(isoInstant(now / 1000n), () => ratingError("Invalid personal rating clock"));
  const sql = state.sql;

  return yield* sql.withTransaction(Effect.gen(function* () {
    yield* checkOwner(state);
    yield* refuseTempRatingConflicts(sql);
    const version = yield* personalRatingSchema(sql, rating.profile_id);

    if (version === 1) return yield* ratingError("Personal feedback v1 is read-only");

    if (version === null) yield* createPersonalRatingSchema(sql, rating.profile_id);

    const rows = yield* sql<PersonalRatingEventRow>`INSERT INTO main.personal_ratings(
      profile_id, source, ad_id, source_version, rating, reason, result_id, input_fingerprint,
      profile_fingerprint, preferences_fingerprint, rules_fingerprint, scoring_version, review_prompt_version, created_at
    ) VALUES (${rating.profile_id}, ${source}, ${ad}, ${sourceVersion}, ${rating.rating}, ${reason}, ${result},
      ${inputFingerprint}, ${profileFingerprint}, ${preferencesFingerprint}, ${rulesFingerprint}, ${scoringVersion}, ${promptVersion}, ${createdAt})
    RETURNING CAST(id AS TEXT) AS id, ad_id, source, source_version, rating, reason, created_at, result_id`;

    const row = rows[0];

    if (rows.length !== 1 || row === undefined) return yield* ratingError("Rating insert could not be read back");

    return yield* decode(EventRow, row);
  }));
});

export const readPersonalRatingEvents = (state: JudgeDatabaseHandle, profileId: string) => state.sql.readSnapshot(Effect.gen(function* () {
  yield* selectedProfile(state, profileId);
  const sql = state.sql;
  const version = yield* personalRatingSchema(sql, profileId);

  if (version === null) return [];

  yield* checkOwner(state);

  const rows = yield* sql<PersonalRatingEventRow>`SELECT CAST(id AS TEXT) AS id, ad_id, source, source_version,
    rating, reason, created_at, result_id FROM main.personal_ratings WHERE profile_id=${profileId}
    ORDER BY julianday(created_at), personal_ratings.id LIMIT ${maxRatingEvents + 1}`;

  if (rows.length > maxRatingEvents) return yield* ratingError("Personal rating history exceeds the feedback events limit");

  return yield* decode(EventRows, rows);
}));
