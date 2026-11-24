import { Effect, Schema } from "effect";
import { readReadonlySqlite } from "../shared/readonly-sqlite.ts";
import { decodePinnedPhoneStoreRow, isPhoneStoreSchemaObject, PhoneProfileId, PINNED_PHONE_SCHEMA_QUERY } from "./phone-store-schema.ts";
import { MAX_STARRED_JOBS, StarredJobsError, type StarredJobsInput } from "./starred-jobs.ts";

const unavailable = () => new StarredJobsError({ message: "Starred-jobs source is unavailable" });
const isProfileId = Schema.is(PhoneProfileId);

type Star = StarredJobsInput["stars"][number];

/** Read all current stars for one selected profile, independent of the latest capture. */
export const readSelectedStars = (path: string, profileId: string) => Effect.gen(function* () {
  if (!isProfileId(profileId)) return yield* unavailable();

  const stars = yield* readReadonlySqlite(path, "feedback", (db) => {
    const schema = db.query(PINNED_PHONE_SCHEMA_QUERY).values();

    if (schema.length !== 1 || !isPhoneStoreSchemaObject(schema[0])) throw unavailable();

    const rows = db.query(`SELECT listing_id, starred, reaction, updated_at FROM main.shortlist_feedback
      WHERE profile_id = ? AND starred = 1 ORDER BY listing_id LIMIT ?`).all(profileId, MAX_STARRED_JOBS + 1);

    if (rows.length > MAX_STARRED_JOBS) throw unavailable();

    const selected: Star[] = [];
    let previous = "";

    for (const raw of rows) {
      const row = decodePinnedPhoneStoreRow(raw);

      if (row.starred !== 1n || row.listing_id <= previous) throw unavailable();
      selected.push({ ...row, starred: row.starred });
      previous = row.listing_id;
    }

    return selected;
  }).pipe(Effect.mapError(unavailable));

  if (stars === null) return yield* unavailable();

  return stars;
});
