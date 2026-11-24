import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import { SqlError } from "@effect/sql/SqlError";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";
import { decodePhoneStoreRow, inspectPhoneStoreSchema, PHONE_FEEDBACK_DDL, PhoneFeedbackInputError, PhoneFeedbackStoreError, PhoneListingId, PhoneListingIds, PhoneProfileId, PhoneReaction, type PhoneStoreRow } from "./phone-store-schema.ts";

const READ_BATCH_SIZE = 500;
const FileExists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));
const unavailable = () => new PhoneFeedbackStoreError({ message: "Feedback store is unavailable" });

const PhoneFeedbackUpdate = Schema.Union(
  Schema.Struct({ field: Schema.Literal("starred"), value: Schema.Boolean }),
  Schema.Struct({ field: Schema.Literal("reaction"), value: PhoneReaction }),
);

export type PhoneFeedbackUpdate = typeof PhoneFeedbackUpdate.Type;

export interface PhoneFeedbackState {
  readonly starred: boolean;
  readonly reaction: typeof PhoneReaction.Type;
  readonly updated_at: string | null;
}

type PhoneFeedbackError = PhoneFeedbackInputError | PhoneFeedbackStoreError;

export class PhoneFeedbackStore extends Context.Tag("pulse/PhoneFeedbackStore")<PhoneFeedbackStore, {
  readonly read: (profileId: string, listingIds: readonly string[]) => Effect.Effect<ReadonlyMap<string, PhoneFeedbackState>, PhoneFeedbackError>;
  readonly update: (profileId: string, listingId: string, update: PhoneFeedbackUpdate) => Effect.Effect<PhoneFeedbackState, PhoneFeedbackError>;
}>() {}

const prepareLocalPath = (filename: string) => Effect.tryPromise({
  try: async () => {
    try {
      const file = await open(filename, "wx", 0o600);
      await file.close();
    } catch (error) {
      if (!FileExists(error)) throw error;
    }

    const info = await stat(filename);

    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw unavailable();
  },
  catch: unavailable,
});

const rowError = () => new PhoneFeedbackStoreError({ message: "Feedback store row is invalid" });
const stateFromRow = ({ starred, reaction, updated_at }: PhoneStoreRow): PhoneFeedbackState => ({ starred: starred === 1n, reaction, updated_at });

const runLocal = <A>(path: string, program: (sql: SqliteResource) => Effect.Effect<A, SqlError | PhoneFeedbackStoreError>) => Effect.scoped(Effect.gen(function* () {
  if (!path) return yield* unavailable();
  // Force relative filenames to be literal paths, including SQLite's special names.
  const filename = isAbsolute(path) ? path : `./${path}`;
  yield* prepareLocalPath(filename);

  const sql = yield* acquireSqliteResource({ filename, create: false, readwrite: true }).pipe(
    Effect.provide(Reactivity.layer), Effect.catchAllDefect(() => Effect.fail(unavailable())),
  );

  return yield* sql.withTransaction(Effect.gen(function* () {
    if ((yield* inspectPhoneStoreSchema(sql)) === "empty") yield* sql.unsafe(PHONE_FEEDBACK_DDL);

    return yield* program(sql);
  })).pipe(
    Effect.provideService(SqlClient.SafeIntegers, true),
    // The transaction helper raises commit/rollback SQL failures as defects.
    Effect.catchSomeDefect((error) => error instanceof SqlError ? Option.some(Effect.fail(unavailable())) : Option.none()),
    Effect.mapError((error) => error instanceof PhoneFeedbackStoreError ? error : unavailable()),
  );
}));

const validate = <A, I, V>(schema: Schema.Schema<A, I>, value: V, message: string) => Schema.decodeUnknown(schema)(value).pipe(
  Effect.mapError(() => new PhoneFeedbackInputError({ message })),
);

const now = Effect.flatMap(Clock.currentTimeMillis, (millis) => Effect.try({
  try: () => new Date(millis).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  catch: unavailable,
}));

export const phoneFeedbackStoreLayer = (path: string) => Layer.succeed(PhoneFeedbackStore, {
  read: (profileId, listingIds) => Effect.gen(function* () {
    const profile = yield* validate(PhoneProfileId, profileId, "Profile ID is invalid");
    const ids = yield* validate(PhoneListingIds, listingIds, "Listing IDs must be valid, bounded and unique");
    const states = new Map<string, PhoneFeedbackState>();

    if (ids.length === 0) return states;

    for (const id of ids) states.set(id, { starred: false, reaction: null, updated_at: null });

    return yield* runLocal(path, (sql) => Effect.gen(function* () {
      for (let start = 0; start < ids.length; start += READ_BATCH_SIZE) {
        const batch = ids.slice(start, start + READ_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(", ");
        const rows = yield* sql.unsafe(`SELECT listing_id, starred, reaction, updated_at FROM shortlist_feedback WHERE profile_id = ? AND listing_id IN (${placeholders})`, [profile, ...batch]);

        for (const row of rows) {
          const saved = yield* decodePhoneStoreRow(row).pipe(Effect.mapError(rowError));

          if (!states.has(saved.listing_id)) return yield* rowError();
          states.set(saved.listing_id, stateFromRow(saved));
        }
      }

      return states;
    }));
  }),
  update: (profileId, listingId, change) => Effect.gen(function* () {
    const profile = yield* validate(PhoneProfileId, profileId, "Profile ID is invalid");
    const id = yield* validate(PhoneListingId, listingId, "Listing ID is invalid");
    const update = yield* validate(PhoneFeedbackUpdate, change, "Feedback update is invalid");
    const stamp = yield* now;

    return yield* runLocal(path, (sql) => Effect.gen(function* () {
      yield* sql`INSERT OR IGNORE INTO shortlist_feedback (profile_id, listing_id, starred, reaction, updated_at) VALUES (${profile}, ${id}, 0, NULL, ${stamp})`;

      if (update.field === "starred") {
        const value = Number(update.value);
        yield* sql`UPDATE shortlist_feedback SET starred = ${value}, updated_at = ${stamp} WHERE profile_id = ${profile} AND listing_id = ${id} AND starred IS NOT ${value}`;
      } else {
        yield* sql`UPDATE shortlist_feedback SET reaction = ${update.value}, updated_at = ${stamp} WHERE profile_id = ${profile} AND listing_id = ${id} AND reaction IS NOT ${update.value}`;
      }

      const rows = yield* sql`SELECT listing_id, starred, reaction, updated_at FROM shortlist_feedback WHERE profile_id = ${profile} AND listing_id = ${id}`;
      const row = rows[0];

      if (rows.length !== 1 || !row) return yield* rowError();
      const saved = yield* decodePhoneStoreRow(row).pipe(Effect.mapError(rowError));

      if (saved.listing_id !== id) return yield* rowError();

      return stateFromRow(saved);
    }));
  }),
});
