import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { dirname, isAbsolute } from "node:path";
import { CollectionOptions, CollectionResult, SourceRefreshSummary, type FilterSourcePolicy } from "../../contracts/source.ts";
import type { ManifestSourceSnapshot } from "../../contracts/source-readers.ts";
import { extractSalary } from "../market/salary.ts";
import { SourceError } from "./errors.ts";
import { sync, wallTimestamp, type IngestRules } from "./ingestion.ts";
import { AddressClient, resolveCandidates, type ResolutionResult } from "./locations.ts";
import { NavClient } from "./nav-client.ts";
import { filterSnapshot, refreshLocationEvidence, refreshMissing, refreshOccupations } from "./pipeline.ts";
import { readManifestSnapshot, sourceState } from "./readers.ts";
import { readLocationCheckpoint, saveLocationCheckpoint, sourceCheckFresh } from "./resources.ts";
import { initializeSourceStorage, upgradeSourceStorage } from "./schema.ts";
import { acquireStore, readSnapshot, type SourceSql, type StoreError } from "./store.ts";
import { sourceTopics } from "./topics.ts";
import { timestamp } from "./core.ts";

// The orchestration owner supplies a scoped, inter-process lock. No unlocked default.
export class SourceWriterLock extends Context.Tag("pulse/SourceWriterLock")<SourceWriterLock, {
  readonly acquire: (databasePath: string) => Effect.Effect<void, SourceError, Scope.Scope>;
}>() {}

export const ingestionRules: IngestRules = { salary: extractSalary, topics: sourceTopics };

export class Source extends Context.Tag("pulse/Source")<Source, {
  readonly initialize: (path: string) => Effect.Effect<void, SourceError>;
  readonly readManifest: (path: string, maxListings: number, now: string) => Effect.Effect<ManifestSourceSnapshot, SourceError>;
  readonly collect: (path: string, options?: CollectionOptions) => Effect.Effect<CollectionResult, SourceError>;
  readonly syncPipeline: (path: string, policy: FilterSourcePolicy, graceDays?: number) => Effect.Effect<CollectionResult, SourceError>;
  readonly checkFresh: (path: string, now: string, maxAgeMillis: number) => Effect.Effect<readonly [boolean, string | null]>;
  readonly refreshPersonal: (path: string, checkpointPath: string, policy: FilterSourcePolicy, graceDays?: number) => Effect.Effect<SourceRefreshSummary, SourceError>;
  readonly refreshEvidence: (path: string, policy: FilterSourcePolicy, graceDays?: number) => Effect.Effect<void, SourceError>;
  readonly resolve: (path: string, policy: FilterSourcePolicy, options?: { readonly after?: string; readonly now?: string; readonly limit?: number; readonly checkpoint?: (uuid: string) => Effect.Effect<void, SourceError> }) => Effect.Effect<ResolutionResult, SourceError>;
}>() {}

const Path = Schema.String.pipe(Schema.filter(isAbsolute));
const validatePath = (path: string) => Schema.decodeUnknown(Path)(path).pipe(Effect.mapError(() => new SourceError({ message: "Source database path must be explicit and absolute" })));
const safeStoreError = (error: StoreError) => error instanceof SourceError ? error : new SourceError({ message: "Source database operation failed" });

// Construction captures only inert services. No file or network resource is acquired.
export const SourceLive = Layer.effect(Source, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const nav = yield* NavClient;
  const address = yield* AddressClient;

  const openWriter = (path: string) => Effect.gen(function* () {
    const exists = yield* fs.exists(path).pipe(Effect.mapError(() => new SourceError({ message: "Source database is unavailable" })));

    if (!exists) yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.mapError(() => new SourceError({ message: "Source database is unavailable" })));

    const sql = yield* acquireStore(path, exists ? "existing" : "create");

    if (exists) yield* upgradeSourceStorage(sql);
    else {
      yield* sql.withTransaction(initializeSourceStorage(sql));
      yield* fs.chmod(path, 0o600).pipe(Effect.mapError(() => new SourceError({ message: "Cannot protect new source database" })));
    }

    return sql;
  });

  const write = <A>(path: string, operation: (sql: SourceSql) => Effect.Effect<A, StoreError, FileSystem.FileSystem>, locked = false) => Effect.scoped(Effect.gen(function* () {
    yield* validatePath(path);

    if (locked) {
      const lock = yield* Effect.serviceOption(SourceWriterLock);

      if (Option.isNone(lock)) return yield* new SourceError({ message: "Source writer lock is unavailable", code: "source_writer_lock_unavailable" });

      yield* lock.value.acquire(path);
    }

    const sql = yield* openWriter(path);

    return yield* operation(sql);
  })).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(safeStoreError));

  return {
    initialize: (path: string) => Effect.scoped(Effect.gen(function* () {
      yield* validatePath(path);

      if (yield* fs.exists(path).pipe(Effect.mapError(() => new SourceError({ message: "Source database is unavailable" })))) return yield* new SourceError({ message: "Source initialization refuses an existing path" });

      yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.mapError(() => new SourceError({ message: "Cannot create source directory" })));
      yield* fs.open(path, { flag: "wx", mode: 0o600 }).pipe(Effect.mapError(() => new SourceError({ message: "Source initialization refuses an existing path" })));
      const sql = yield* acquireStore(path, "existing");
      yield* sql.withTransaction(initializeSourceStorage(sql));
    })).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(safeStoreError)),
    readManifest: (path: string, maxListings: number, now: string) => Effect.scoped(Effect.gen(function* () {
      const sql = yield* acquireStore(path, "readonly");

      return yield* readSnapshot(sql, readManifestSnapshot(sql, maxListings, now));
    })).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(safeStoreError)),
    collect: (path: string, options: CollectionOptions = {}) => Schema.decodeUnknown(CollectionOptions)(options).pipe(
      Effect.mapError(() => new SourceError({ message: "Invalid collection options" })),
      Effect.flatMap((options) => Effect.gen(function* () {
        // Reject invalid caller clocks before writer acquisition or legacy upgrades.
        const selected = options.now === undefined ? options : { ...options, now: yield* timestamp(options.now) };

        return yield* write(path, (sql) => Effect.gen(function* () {
          const session = yield* nav.session();
          const result = yield* sync(sql, session, ingestionRules, selected);

          return yield* Schema.decodeUnknown(CollectionResult)(result).pipe(Effect.mapError(() => new SourceError({ message: "Invalid collection result" })));
        }));
      })),
    ),
    // Retained nav_pipeline operation for the outer runner: one source lock and
    // one bounded session cover sync plus missing-detail refresh. This does not
    // add optional location-evidence or occupation refresh work.
    syncPipeline: (path: string, policy: FilterSourcePolicy, graceDays = 0) => Schema.decodeUnknown(Schema.Int.pipe(Schema.between(0, 14)))(graceDays).pipe(
      Effect.mapError(() => new SourceError({ message: "Invalid text grace" })),
      Effect.flatMap((graceDays) => write(path, (sql) => Effect.gen(function* () {
        const session = yield* nav.session({ maxRequests: 100, seconds: 240 });
        const result = yield* sync(sql, session, ingestionRules, { maxPages: 20, graceDays });

        if (!result.caught_up) return yield* new SourceError({ message: "Source sync has not caught up; retry later", code: "source_not_caught_up", transient: true });
        yield* refreshMissing(sql, session, policy, ingestionRules, graceDays);

        return yield* Schema.decodeUnknown(CollectionResult)(result).pipe(Effect.mapError(() => new SourceError({ message: "Invalid collection result" })));
      }), true)),
    ),
    checkFresh: (path: string, now: string, maxAgeMillis: number) => sourceCheckFresh(path, now, maxAgeMillis).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    refreshPersonal: (path: string, checkpointPath: string, policy: FilterSourcePolicy, graceDays = 0) => write(path, (sql) => Effect.gen(function* () {
      yield* Schema.decodeUnknown(Schema.Int.pipe(Schema.between(0, 14)))(graceDays).pipe(Effect.mapError(() => new SourceError({ message: "Invalid text grace" })));
      const feed = yield* nav.session({ maxRequests: 30, seconds: 90 });
      const collected = yield* sync(sql, feed, ingestionRules, { maxPages: 5, graceDays });
      const empty = { ready: false, checked_at: null, feed_requests: feed.requests, location_requests: 0, location_attempted: 0, location_resolved: 0, location_unknown: 0, occupation_requests: 0, occupation_pending: 0 };

      if (!collected.caught_up) return empty;

      yield* refreshLocationEvidence(sql, feed, policy, ingestionRules, graceDays);
      yield* refreshMissing(sql, feed, policy, ingestionRules, graceDays);
      const locationClient = yield* nav.session({ maxRequests: 10, seconds: 90 });
      const lookup = yield* address.session(locationClient.deadline).pipe(Effect.mapError(() => new SourceError({ message: "Location resolution failed" })));
      const after = yield* readLocationCheckpoint(checkpointPath);
      const snapshot = yield* filterSnapshot(sql, yield* wallTimestamp);

      const candidates = yield* Effect.try({ try: () => policy.locationCandidates(snapshot), catch: () => new SourceError({ message: "Filter policy failed" }) });
      const checkpoint = (id: string) => saveLocationCheckpoint(checkpointPath, id).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const resolutionOptions = after === null ? { checkpoint } : { checkpoint, after };
      const location = yield* resolveCandidates(sql, locationClient, lookup, candidates, 5, resolutionOptions).pipe(Effect.mapError((error) => error instanceof SourceError ? error : new SourceError({ message: "Location resolution failed" })));

      const occupationClient = yield* nav.session({ maxRequests: 30, seconds: 90 });
      const occupations = yield* refreshOccupations(sql, occupationClient, policy, ingestionRules, graceDays);
      const state = yield* sourceState(sql);

      return yield* Schema.decodeUnknown(SourceRefreshSummary)({ ready: state.caught_up === "1" && state.checked !== undefined,
        checked_at: state.checked ?? null, feed_requests: feed.requests,
        location_requests: locationClient.requests + lookup.requests, location_attempted: location.attempted,
        location_resolved: location.resolved, location_unknown: location.unknown,
        occupation_requests: occupationClient.requests, occupation_pending: occupations.pending,
      }).pipe(Effect.mapError(() => new SourceError({ message: "Invalid Source refresh result" })));
    }), true).pipe(Effect.mapError((error) => error.code ? error : new SourceError({ message: "source_refresh_failed", code: "source_refresh_failed" }))),
    refreshEvidence: (path: string, policy: FilterSourcePolicy, graceDays = 0) => write(path, (sql) => Effect.gen(function* () {
      const session = yield* nav.session();
      yield* refreshLocationEvidence(sql, session, policy, ingestionRules, graceDays);
      yield* refreshMissing(sql, session, policy, ingestionRules, graceDays);
      yield* refreshOccupations(sql, session, policy, ingestionRules, graceDays);
    }), true),
    resolve: (path: string, policy: FilterSourcePolicy, options: { readonly after?: string; readonly now?: string; readonly limit?: number; readonly checkpoint?: (uuid: string) => Effect.Effect<void, SourceError> } = {}) => Effect.gen(function* () {
      // Bad limits/clocks must not acquire a lock or create/upgrade a store.
      const { limit = 5, ...resolution } = options;
      yield* Schema.decodeUnknown(Schema.Int.pipe(Schema.between(1, 10)))(limit).pipe(Effect.mapError(() => new SourceError({ message: "Invalid location resolution limit" })));
      const selected = resolution.now === undefined ? resolution : { ...resolution, now: yield* timestamp(resolution.now) };

      return yield* write(path, (sql) => Effect.gen(function* () {
        const session = yield* nav.session({ maxRequests: 10, seconds: 90 });
        const lookup = yield* address.session(session.deadline).pipe(Effect.mapError(() => new SourceError({ message: "Location resolution failed" })));
        const now = selected.now ?? (yield* wallTimestamp);
        const snapshot = yield* filterSnapshot(sql, now);

        const candidates = yield* Effect.try({ try: () => policy.locationCandidates(snapshot), catch: () => new SourceError({ message: "Filter policy failed" }) });

        return yield* resolveCandidates(sql, session, lookup, candidates, limit, selected).pipe(Effect.mapError((error) => error instanceof SourceError ? error : new SourceError({ message: "Location resolution failed" })));
      }), true);
    }),
  };
}));
