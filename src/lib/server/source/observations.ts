import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Either, Exit, Option, Schema } from "effect";
import { Observation, ObservationRun, ObservationStatus, RunObservation } from "../../contracts/observations.ts";
import { strip } from "../shared/text.ts";
import { decodeProfileId } from "../profile/core.ts";
import { instant, utcText, uuid } from "./core.ts";
import { ObservationError } from "./errors.ts";
import { withReservedConnection, type SourceSql } from "./store.ts";

export { Observation, ObservationRun, ObservationStatus, RunObservation };

const error = (message: string) => new ObservationError({ message });
const profile = (id: string | null): Either.Either<string | null, ObservationError> => id === null ? Either.right(null) : Either.mapLeft(decodeProfileId(id), () => error("Invalid profile ID"));
const listing = (id: string): Either.Either<string, ObservationError> => Either.flatMap(decode(Schema.String, id), (value) => Either.mapLeft(uuid(value), () => error("Listing UUID must be a UUID string")));

const decode = <A, I>(schema: Schema.Schema<A, I>, value: I): Either.Either<A, ObservationError> =>
  Either.mapLeft(Schema.decodeUnknownEither(schema)(value), () => error("Invalid observation value"));

const time = (value: string, name: string): Either.Either<string, ObservationError> => {
  const text = Schema.decodeUnknownEither(Schema.String)(value);
  const parsed = Either.isRight(text) ? instant(text.right) : Option.none();

  return Option.isSome(parsed) && parsed.value >= -62_135_596_800_000_000n && parsed.value < 253_402_300_800_000_000n ? Either.right(utcText(parsed.value, "microseconds")) : Either.left(error(`${name} must be a timezone-aware datetime`));
};

const positive = (value: number): Either.Either<number, ObservationError> => Either.mapLeft(decode(Schema.Number.pipe(Schema.int(), Schema.positive()), value), () => error("Run ID must be a positive integer"));
const SourceVersion = Schema.String.pipe(Schema.filter((value) => value.length > 0 && value === strip(value) && !Array.from(value).some((character) => character.codePointAt(0)! < 32)));
const version = (value: string) => Either.mapLeft(decode(SourceVersion, value), () => error("Invalid source changed timestamp"));

// Reserve the connection across the whole savepoint, including when nested.
const atomic = <A, E, R>(sql: SourceSql, program: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> => {
  const run = Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* sql`SAVEPOINT observation_history_api`;
    const result = yield* Effect.exit(restore(program));

    if (Exit.isFailure(result)) yield* sql`ROLLBACK TO SAVEPOINT observation_history_api`;
    yield* sql`RELEASE SAVEPOINT observation_history_api`;

    return yield* result;
  }));

  return withReservedConnection(sql, run);
};

const allowed = new Set(["observation_schema", "observations", "observation_runs", "run_baselines", "run_observations", "feedback", "proposals", "proposal_evidence"]);

export const initializeObservationSchema = (sql: SourceSql): Effect.Effect<void, SqlError | ObservationError> => atomic(sql, Effect.gen(function* () {
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`;

  if (tables.some(({ name }) => !name.startsWith("sqlite_") && !allowed.has(name))) return yield* error("Observation history requires its own review database");
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS observation_schema (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                version INTEGER NOT NULL)`);
  const schema = yield* sql<{ version: number; storage: string }>`SELECT version,typeof(version) AS storage FROM observation_schema WHERE singleton=1`;
  let v = schema[0]?.version;

  if (v === undefined) { yield* sql`INSERT INTO observation_schema(singleton,version) VALUES (1,0)`; v = 0; }

  if ((schema.length > 0 && schema[0]?.storage !== "integer") || !Number.isInteger(v) || v < 0 || v > 3) return yield* error("Unsupported observation schema version");

  while (v < 3) {
    if (v === 0) yield* sql.unsafe(`CREATE TABLE observations (
                        listing_uuid TEXT PRIMARY KEY,
                        source_changed_at TEXT NOT NULL,
                        first_seen_at TEXT NOT NULL,
                        last_seen_at TEXT NOT NULL)`);

    if (v === 1) {
      yield* sql.unsafe(`CREATE TABLE observation_runs (
                        run_id INTEGER PRIMARY KEY,
                        started_at TEXT NOT NULL)`);
      yield* sql.unsafe(`CREATE TABLE run_baselines (
                        run_id INTEGER NOT NULL,
                        listing_uuid TEXT NOT NULL,
                        source_changed_at TEXT NOT NULL,
                        PRIMARY KEY(run_id, listing_uuid))`);
      yield* sql.unsafe(`CREATE TABLE run_observations (
                        run_id INTEGER NOT NULL,
                        listing_uuid TEXT NOT NULL,
                        source_changed_at TEXT NOT NULL,
                        observed_at TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN
                            ('new','changed','previously_seen')),
                        PRIMARY KEY(run_id, listing_uuid))`);
    }

    if (v === 2) {
      yield* sql`ALTER TABLE observations RENAME TO observations_v2`;
      yield* sql.unsafe(`CREATE TABLE observations (
                        profile_id TEXT,
                        profile_scope TEXT NOT NULL,
                        listing_uuid TEXT NOT NULL,
                        source_changed_at TEXT NOT NULL,
                        first_seen_at TEXT NOT NULL,
                        last_seen_at TEXT NOT NULL,
                        PRIMARY KEY(profile_scope, listing_uuid))`);
      yield* sql`INSERT INTO observations (profile_id,profile_scope,listing_uuid,source_changed_at,first_seen_at,last_seen_at) SELECT NULL,'',listing_uuid,source_changed_at,first_seen_at,last_seen_at FROM observations_v2`;
      yield* sql`DROP TABLE observations_v2`;
      yield* sql`ALTER TABLE observation_runs ADD COLUMN profile_id TEXT`;
      yield* sql`ALTER TABLE run_observations ADD COLUMN profile_id TEXT`;
    }

    v++;
    yield* sql`UPDATE observation_schema SET version=${v} WHERE singleton=1`;
  }
}));

export const beginObservationRun = (sql: SourceSql, startedAt: string, profileId: string | null = null) => Effect.gen(function* () {
  const started = yield* time(startedAt, "run start time");
  const id = yield* profile(profileId);
  yield* initializeObservationSchema(sql);

  return yield* atomic(sql, Effect.gen(function* () {
    yield* sql`INSERT INTO observation_runs(started_at,profile_id) VALUES (${started},${id})`;
    const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() AS id`;
    const row = rows[0];

    if (!row) return yield* Effect.dieMessage("Missing inserted run ID");
    const run = row.id;
    yield* sql`INSERT INTO run_baselines(run_id,listing_uuid,source_changed_at) SELECT ${run},listing_uuid,source_changed_at FROM observations WHERE profile_scope=${id ?? ""}`;

    return run;
  }));
});

export const recordObservation = (sql: SourceSql, input: { readonly runId: number; readonly listingUuid: string; readonly sourceChangedAt: string; readonly observedAt: string; readonly profileId?: string | null }) => Effect.gen(function* () {
  yield* decode(Schema.Struct({ runId: Schema.Number, listingUuid: Schema.String, sourceChangedAt: Schema.String, observedAt: Schema.String, profileId: Schema.optional(Schema.NullOr(Schema.String)) }), input);
  const run = yield* positive(input.runId);
  const uuidValue = yield* listing(input.listingUuid);
  const source = yield* version(input.sourceChangedAt);
  const observed = yield* time(input.observedAt, "observation time");
  const id = yield* profile(input.profileId ?? null);
  yield* initializeObservationSchema(sql);

  return yield* atomic(sql, Effect.gen(function* () {
    const found = yield* sql`SELECT 1 FROM observation_runs WHERE run_id=${run} AND profile_id IS ${id}`;

    if (!found.length) return yield* error(`Unknown observation run: ${run}`);
    const baseline = yield* sql<{ source_changed_at: string }>`SELECT source_changed_at FROM run_baselines WHERE run_id=${run} AND listing_uuid=${uuidValue}`;
    const status: ObservationStatus = !baseline.length ? "new" : baseline[0]?.source_changed_at === source ? "previously_seen" : "changed";
    yield* sql`INSERT INTO observations (profile_id,profile_scope,listing_uuid,source_changed_at,first_seen_at,last_seen_at) VALUES (${id},${id ?? ""},${uuidValue},${source},${observed},${observed}) ON CONFLICT(profile_scope,listing_uuid) DO UPDATE SET first_seen_at=MIN(observations.first_seen_at,excluded.first_seen_at), source_changed_at=CASE WHEN ${run} >= COALESCE((SELECT MAX(run_id) FROM run_observations WHERE listing_uuid=excluded.listing_uuid AND profile_id IS ${id}), 0) THEN excluded.source_changed_at ELSE observations.source_changed_at END, last_seen_at=MAX(observations.last_seen_at,excluded.last_seen_at)`;
    yield* sql`INSERT OR IGNORE INTO run_observations (run_id,listing_uuid,source_changed_at,observed_at,status,profile_id) VALUES (${run},${uuidValue},${source},${observed},${status},${id})`;
    const captured = yield* sql<{ status: ObservationStatus }>`SELECT status FROM run_observations WHERE run_id=${run} AND listing_uuid=${uuidValue}`;
    const row = captured[0];

    if (!row) return yield* Effect.dieMessage("Missing captured observation");

    return yield* decode(ObservationStatus, row.status);
  }));
});

const readTime = (value: string) => Either.map(time(value, "stored observation time"), (text) => text.endsWith(".000000+00:00") ? text.replace(".000000+00:00", "+00:00") : text);

const columns = (sql: SourceSql, table: "observations" | "observation_runs") => table === "observations" ? sql<{ name: string }>`PRAGMA table_info(observations)` : sql<{ name: string }>`PRAGMA table_info(observation_runs)`;

export const getCurrentObservationRun = (sql: SourceSql, profileId: string | null = null) => Effect.gen(function* () {
  const id = yield* profile(profileId);
  const scoped = (yield* columns(sql, "observation_runs")).some((row) => row.name === "profile_id");

  if (!scoped && id !== null) return null;
  const rows = scoped ? yield* sql<ObservationRun>`SELECT run_id,started_at FROM observation_runs WHERE profile_id IS ${id} ORDER BY run_id DESC LIMIT 1` : yield* sql<ObservationRun>`SELECT run_id,started_at FROM observation_runs WHERE 1=1 ORDER BY run_id DESC LIMIT 1`;

  const row = rows[0];

  return row ? yield* decode(ObservationRun, { ...row, started_at: yield* readTime(row.started_at) }) : null;
});

export const getObservation = (sql: SourceSql, listingUuid: string, profileId: string | null = null) => Effect.gen(function* () {
  const uuidValue = yield* listing(listingUuid);
  const id = yield* profile(profileId);
  const scoped = (yield* columns(sql, "observations")).some((row) => row.name === "profile_scope");

  if (!scoped && id !== null) return null;
  const rows = scoped ? yield* sql<Observation>`SELECT listing_uuid,source_changed_at,first_seen_at,last_seen_at FROM observations WHERE profile_scope=${id ?? ""} AND listing_uuid=${uuidValue}` : yield* sql<Observation>`SELECT listing_uuid,source_changed_at,first_seen_at,last_seen_at FROM observations WHERE listing_uuid=${uuidValue}`;

  const row = rows[0];

  return row ? yield* decode(Observation, { ...row, first_seen_at: yield* readTime(row.first_seen_at), last_seen_at: yield* readTime(row.last_seen_at) }) : null;
});

export const listRunObservations = (sql: SourceSql, runId: number, options: { readonly status?: ObservationStatus | null; readonly limit?: number; readonly offset?: number; readonly profileId?: string | null } = {}) => Effect.gen(function* () {
  yield* decode(Schema.Struct({ status: Schema.optional(Schema.NullOr(ObservationStatus)), limit: Schema.optional(Schema.Number), offset: Schema.optional(Schema.Number), profileId: Schema.optional(Schema.NullOr(Schema.String)) }), options);
  const run = yield* positive(runId);
  const id = yield* profile(options.profileId ?? null);
  const limit = options.limit === undefined ? 100 : options.limit;
  const offset = options.offset === undefined ? 0 : options.offset;

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return yield* error("Limit must be from 1 to 1000");

  if (!Number.isSafeInteger(offset) || offset < 0) return yield* error("Offset must be a nonnegative integer");

  if (options.status != null && !["new", "changed", "previously_seen"].includes(options.status)) return yield* error("Unknown observation status");
  const scoped = (yield* columns(sql, "observation_runs")).some((row) => row.name === "profile_id");

  if (!scoped && id !== null) return yield* error(`Unknown observation run: ${run}`);
  const found = scoped ? yield* sql`SELECT 1 FROM observation_runs WHERE run_id=${run} AND profile_id IS ${id}` : yield* sql`SELECT 1 FROM observation_runs WHERE run_id=${run}`;

  if (!found.length) return yield* error(`Unknown observation run: ${run}`);

  const rows = options.status == null ? yield* sql<RunObservation>`SELECT run_id,listing_uuid,source_changed_at,observed_at,status FROM run_observations WHERE run_id=${run} ORDER BY listing_uuid LIMIT ${limit} OFFSET ${offset}` : yield* sql<RunObservation>`SELECT run_id,listing_uuid,source_changed_at,observed_at,status FROM run_observations WHERE run_id=${run} AND status=${options.status} ORDER BY listing_uuid LIMIT ${limit} OFFSET ${offset}`;

  return yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
    return yield* decode(RunObservation, { ...row, observed_at: yield* readTime(row.observed_at) });
  }));
});

export const assignUnscopedHistory = (sql: SourceSql, profileId: string | null) => Effect.gen(function* () {
  const id = yield* profile(profileId);

  if (id === null) return yield* error("Profile ID is required");
  yield* initializeObservationSchema(sql);

  return yield* atomic(sql, Effect.gen(function* () {
    const collision = yield* sql`SELECT 1 FROM observations legacy JOIN observations owned ON owned.listing_uuid=legacy.listing_uuid WHERE legacy.profile_scope='' AND owned.profile_scope=${id} LIMIT 1`;

    if (collision.length) return yield* error("Profile already has colliding observation history");
    yield* sql`UPDATE observations SET profile_id=${id}, profile_scope=${id} WHERE profile_scope=''`;
    const changed = yield* sql<{ count: number }>`SELECT changes() AS count`;
    yield* sql`UPDATE observation_runs SET profile_id=${id} WHERE profile_id IS NULL`;
    yield* sql`UPDATE run_observations SET profile_id=${id} WHERE profile_id IS NULL`;
    const row = changed[0];

    if (!row) return yield* Effect.dieMessage("Missing SQLite change count");

    return row.count;
  }));
});
