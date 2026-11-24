import { Data, Effect, Schema } from "effect";
import type { SqliteResource } from "../shared/sqlite-resource.ts";

const PROFILE_ID_LIMIT = 64;
const LISTING_ID_LIMIT = 128;
const MAX_SHORTLIST_LISTINGS = 66_666;

export const PhoneProfileId = Schema.String.pipe(Schema.maxLength(PROFILE_ID_LIMIT), Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/));
export const PhoneListingId = Schema.String.pipe(Schema.maxLength(LISTING_ID_LIMIT), Schema.pattern(/^[a-z0-9_-]+(?![\s\S])/));
const BoundedIds = Schema.Unknown.pipe(Schema.filter((value) => Array.isArray(value) && value.length <= MAX_SHORTLIST_LISTINGS));
export const PhoneListingIds = Schema.compose(BoundedIds, Schema.Array(PhoneListingId).pipe(Schema.filter((ids) => new Set(ids).size === ids.length)));
export const PhoneReaction = Schema.NullOr(Schema.Literal("up", "down"));

export class PhoneFeedbackInputError extends Data.TaggedError("PhoneFeedbackInputError")<{ readonly message: string }> {}

export class PhoneFeedbackStoreError extends Data.TaggedError("PhoneFeedbackStoreError")<{ readonly message: string }> {}

export const PHONE_FEEDBACK_DDL = `CREATE TABLE shortlist_feedback (
    profile_id TEXT NOT NULL
        CHECK (typeof(profile_id) = 'text'
               AND length(profile_id) BETWEEN 1 AND ${PROFILE_ID_LIMIT})
        CHECK (profile_id NOT GLOB '*[^a-z0-9-]*')
        CHECK (profile_id NOT GLOB '-*' AND profile_id NOT GLOB '*-'
               AND profile_id NOT GLOB '*--*'),
    listing_id TEXT NOT NULL
        CHECK (typeof(listing_id) = 'text'
               AND length(listing_id) BETWEEN 1 AND ${LISTING_ID_LIMIT})
        CHECK (listing_id NOT GLOB '*[^a-z0-9_-]*'),
    starred INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(starred) = 'integer' AND starred IN (0, 1)),
    reaction TEXT CHECK (reaction IS NULL OR
                          (typeof(reaction) = 'text' AND reaction IN ('up', 'down'))),
    updated_at TEXT NOT NULL
        CHECK (typeof(updated_at) = 'text' AND length(updated_at) = 25
               AND substr(updated_at, 20) = '+00:00'),
    PRIMARY KEY (profile_id, listing_id)
) WITHOUT ROWID`;

// Match the frozen Python whitespace normalization without accepting a BOM as whitespace.
// oxlint-disable-next-line eslint/no-control-regex
const normalizeSql = (sql: string) => sql.replace(/[\p{White_Space}\u001c-\u001f]+/gu, " ").replace(/^ | $/g, "");

const expectedObject = Schema.Tuple(Schema.Literal("table"), Schema.Literal("shortlist_feedback"), Schema.Literal("shortlist_feedback"),
  Schema.String.pipe(Schema.filter((sql) => normalizeSql(sql) === normalizeSql(PHONE_FEEDBACK_DDL))));

export const isPhoneStoreSchemaObject = Schema.is(expectedObject);

export const PINNED_PHONE_SCHEMA_QUERY = `SELECT type, name, tbl_name, sql FROM main.sqlite_master
      WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY type, name LIMIT 2`;

// Inspect only; callers decide whether an empty SQLite schema can be initialized.
export const inspectPhoneStoreSchema = (sql: SqliteResource) => Effect.gen(function* () {
  const objects = yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!'`.values;

  if (objects.length === 0) return "empty" as const;

  if (objects.length === 1 && isPhoneStoreSchemaObject(objects[0])) return "ready" as const;

  return yield* new PhoneFeedbackStoreError({ message: "Feedback store schema is invalid" });
});

const UtcStamp = Schema.String.pipe(Schema.filter((stamp) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00(?![\s\S])/.test(stamp) || stamp.startsWith("0000-")) return false;
  const date = new Date(stamp);

  return Number.isFinite(date.getTime()) && date.toISOString().replace(".000Z", "+00:00") === stamp;
}));

// Use the SQLite safe-integer mode, which distinguishes INTEGER from REAL.
export const PhoneStoreRow = Schema.Struct({ listing_id: PhoneListingId, starred: Schema.Literal(0n, 1n), reaction: PhoneReaction, updated_at: UtcStamp });

export type PhoneStoreRow = typeof PhoneStoreRow.Type;

export const decodePhoneStoreRow = Schema.decodeUnknown(PhoneStoreRow, { onExcessProperty: "error", errors: "first" });
export const decodePinnedPhoneStoreRow = Schema.decodeUnknownSync(PhoneStoreRow, { onExcessProperty: "error", exact: true });
