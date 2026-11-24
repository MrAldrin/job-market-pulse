import { Array as EffectArray, Effect, Either, Predicate, Schema } from "effect";
import { RunContext, type CompletedReviewResult } from "../../contracts/judge-state.ts";
import { MAX_REVIEW_CANDIDATES, manifestCommon } from "../filter/manifest.ts";
import { decodeReview, validateReview } from "../filter/review.ts";
import { awareTimestamp } from "../../contracts/support.ts";
import type { PythonJson } from "../shared/python-json.ts";
import { openJudgeConnection, type JudgeConnectionHandle } from "./database.ts";
import { fingerprint, instant, isoInstant } from "./core.ts";
import { freshJudgeProfile, profileMaxAge, readCanonicalManifest, validateSelectedProfile, type JudgeProfileContext } from "./manifests.ts";
import { jsonProperty } from "./stored.ts";
import { JudgeStateError } from "./errors.ts";
import { decodeStored, sqlError, write } from "./session.ts";

type CompletionConnection = Pick<JudgeConnectionHandle, "sql" | "profile_id" | "readonly">;

const Binding = RunContext.pick("profile_fingerprint", "preferences_fingerprint", "rules_fingerprint", "scoring_version");
const MetadataRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const AssessmentIdentity = Schema.Struct({ id: Schema.String, version: Schema.String });

export type CompletionBinding = typeof Binding.Type;

export interface CompletionManifest extends CompletionBinding {
  readonly profile_id: string;
  readonly manifest_id: string;
}

const metadata = (connection: CompletionConnection) => Effect.gen(function* () {
  const rows = yield* connection.sql`SELECT key,value FROM reviewed_identity_metadata`;
  const saved = yield* decodeStored(Schema.Array(MetadataRow), rows);

  return new Map(saved.map((row) => [row.key, row.value]));
});

const matchesMetadata = (saved: ReadonlyMap<string, string>, profileId: string): boolean => saved.size === 2 && saved.get("profile_id") === profileId && saved.get("schema_version") === "1";

// This fixed-namespace transaction is not the completed-review API. Its caller
// must perform the first REAL canonical checks before acquisition, then the
// second REAL checks and manifest-ID comparison in this same transaction.
export const completionTransaction = <A, E, R>(connection: CompletionConnection, effect: Effect.Effect<A, E, R>) => write(connection, Effect.gen(function* () {
  yield* connection.sql`CREATE TABLE IF NOT EXISTS reviewed_identity_metadata (
                   key TEXT PRIMARY KEY, value TEXT NOT NULL
               )`;
  yield* connection.sql`CREATE TABLE IF NOT EXISTS reviewed_identities (
                   profile_id TEXT NOT NULL,
                   listing_id TEXT NOT NULL,
                   source_version TEXT NOT NULL,
                   profile_fingerprint TEXT NOT NULL,
                   preferences_fingerprint TEXT NOT NULL,
                   rules_fingerprint TEXT NOT NULL,
                   scoring_version TEXT NOT NULL,
                   manifest_id TEXT NOT NULL,
                   review_fingerprint TEXT NOT NULL,
                   recorded_at TEXT NOT NULL,
                   PRIMARY KEY(
                       profile_id, listing_id, profile_fingerprint,
                       preferences_fingerprint, rules_fingerprint, scoring_version
                   )
               )`;
  const saved = yield* metadata(connection);

  if (saved.size === 0) {
    yield* connection.sql`INSERT INTO reviewed_identity_metadata(key,value) VALUES ('profile_id',${connection.profile_id}),('schema_version','1')`;
  } else if (!matchesMetadata(saved, connection.profile_id)) return yield* new JudgeStateError({ message: "Review ledger profile or schema mismatch" });

  return yield* effect;
}));

export const reviewedIds = (connection: JudgeConnectionHandle, binding: CompletionBinding) => Effect.gen(function* () {
  if (connection.readonly && !connection.existed) return new Set<string>();

  // A real BEGIN starts before both table and metadata validation. Native RO
  // resources use deferred BEGIN; a held owned transaction uses its savepoint.
  return yield* connection.sql.withTransaction(Effect.gen(function* () {
    const tables = yield* connection.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`;
    const names = new Set(tables.map((row) => row.name));

    if (!names.has("reviewed_identity_metadata") || !names.has("reviewed_identities")) return yield* new JudgeStateError({ message: "Review ledger schema is missing" });

    if (!matchesMetadata(yield* metadata(connection), connection.profile_id)) return yield* new JudgeStateError({ message: "Review ledger profile or schema mismatch" });

    const selected = yield* Either.mapLeft(Schema.decodeUnknownEither(Binding)(binding), (cause) => new JudgeStateError({ message: "Review ledger context is invalid", cause }));
    const rows = yield* connection.sql<{ listing_id: string }>`SELECT listing_id FROM reviewed_identities WHERE profile_id=${connection.profile_id} AND profile_fingerprint=${selected.profile_fingerprint} AND preferences_fingerprint=${selected.preferences_fingerprint} AND rules_fingerprint=${selected.rules_fingerprint} AND scoring_version=${selected.scoring_version}`;

    return new Set(rows.map((row) => row.listing_id));
  }));
}).pipe(Effect.mapError(sqlError));

export interface CompletionPersistence {
  readonly manifest: CompletionManifest;
  readonly raw_review: PythonJson;
  // Only the ID/version projection of the real canonical returned values.
  readonly assessments: readonly PythonJson[];
  // The caller's already formatted aware datetime.isoformat clock value. Keep
  // its offset spelling, unlike PersonalState's always-UTC SQL timestamps.
  readonly recorded_at: string;
}

const ExistingIdentity = Schema.Struct({ source_version: Schema.String, manifest_id: Schema.String, review_fingerprint: Schema.String });

export const persistReviewedIds = (connection: CompletionConnection, values: CompletionPersistence) => Effect.gen(function* () {
  const manifest = values.manifest;

  if (manifest.profile_id !== connection.profile_id) return yield* new JudgeStateError({ message: "Review ledger profile does not match" });

  yield* Either.mapLeft(Schema.decodeUnknownEither(awareTimestamp)(values.recorded_at), (cause) => new JudgeStateError({ message: "Review ledger clock is invalid", cause }));
  const binding = yield* Either.mapLeft(Schema.decodeUnknownEither(Binding)(manifest), (cause) => new JudgeStateError({ message: "Review ledger context is invalid", cause }));
  const assessments = yield* Effect.forEach(values.assessments, (value) => Either.mapLeft(Schema.decodeUnknownEither(AssessmentIdentity)(value), (cause) => new JudgeStateError({ message: "Review ledger assessment identity is invalid", cause })));
  const ids = new Set(assessments.map((row) => row.id));

  if (ids.size === 0 || ids.size > 120 || ids.size !== assessments.length) return yield* new JudgeStateError({ message: "Review must contain 1..120 unique candidate IDs" });

  const reviewHash = fingerprint(values.raw_review);

  return yield* write(connection, Effect.gen(function* () {
    const existing = new Map<string, typeof ExistingIdentity.Type>();

    for (const identity of ids) {
      const rows = yield* connection.sql`SELECT source_version,manifest_id,review_fingerprint FROM reviewed_identities WHERE profile_id=${connection.profile_id} AND listing_id=${identity} AND profile_fingerprint=${binding.profile_fingerprint} AND preferences_fingerprint=${binding.preferences_fingerprint} AND rules_fingerprint=${binding.rules_fingerprint} AND scoring_version=${binding.scoring_version}`;

      if (rows[0]) existing.set(identity, yield* decodeStored(ExistingIdentity, rows[0]));
    }

    if (existing.size > 0) {
      const identical = existing.size === assessments.length && assessments.every((row) => {
        const saved = existing.get(row.id);

        return saved?.source_version === row.version && saved.manifest_id === manifest.manifest_id && saved.review_fingerprint === reviewHash;
      });

      if (identical) return { status: "already_recorded" as const, newly_reviewed: 0 };

      return yield* new JudgeStateError({ message: "A reviewed identity already has a different completed review" });
    }

    for (const row of assessments) {
      yield* connection.sql`INSERT INTO reviewed_identities (profile_id,listing_id,source_version,profile_fingerprint,preferences_fingerprint,rules_fingerprint,scoring_version,manifest_id,review_fingerprint,recorded_at) VALUES (${connection.profile_id},${row.id},${row.version},${binding.profile_fingerprint},${binding.preferences_fingerprint},${binding.rules_fingerprint},${binding.scoring_version},${manifest.manifest_id},${reviewHash},${values.recorded_at})`;
    }

    return { status: "recorded" as const, newly_reviewed: assessments.length };
  }));
}).pipe(Effect.mapError(sqlError));

export interface CompletedReviewOptions {
  readonly now: bigint;
  // Optional caller datetime.isoformat() value; preserve its aware offset spelling.
  readonly recorded_at?: string;
  readonly limit?: number;
  readonly connection?: JudgeConnectionHandle;
}

const completedReviewIds = (review: PythonJson) => Effect.gen(function* () {
  const assessments = jsonProperty(review, "assessments");

  if (!Predicate.isRecord(review) || !EffectArray.isArray<typeof assessments>(assessments)) return yield* new JudgeStateError({ message: "A complete structured review is required" });

  const ids: string[] = [];

  for (const row of assessments) {
    const id = jsonProperty(row, "id");

    if (!Predicate.isString(id)) return yield* new JudgeStateError({ message: "Review must contain 1..120 unique candidate IDs" });

    ids.push(id);
  }

  if (ids.length === 0 || ids.length > MAX_REVIEW_CANDIDATES || new Set(ids).size !== ids.length) return yield* new JudgeStateError({ message: "Review must contain 1..120 unique candidate IDs" });

  return ids;
});

// Both canonical validations are real. The first pass precedes writer
// acquisition; the second rebuilds Source and personal inputs inside its owned
// ledger transaction. A supplied held resource is reused, never reopened.
export const recordCompletedReview = (context: JudgeProfileContext, review: PythonJson, options: CompletedReviewOptions) => Effect.gen(function* () {
  const ids = yield* completedReviewIds(review);
  const recordedAt = options.recorded_at ?? (yield* isoInstant(options.now));

  if ((yield* instant(recordedAt)) !== options.now) return yield* new JudgeStateError({ message: "Completion clock differs from current time" });

  if (options.connection !== undefined) yield* validateSelectedProfile(options.connection, context.profile);

  const profile = yield* freshJudgeProfile(context);
  const common = yield* manifestCommon(profile.bundle.profile_id, profile.settings, undefined, profile.evidence);
  const paths = context.profile.paths;
  const selected = { profile_id: context.profile.profile_id, directory: paths.directory, path: paths.review_db, require_existing: false };

  const currentReviewed = options.connection === undefined
    ? yield* Effect.scoped(Effect.flatMap(openJudgeConnection({ ...selected, readonly: true }, "completion-ledger"), (connection) => reviewedIds(connection, common)))
    : yield* reviewedIds(options.connection, common);

  const limit = options.limit ?? MAX_REVIEW_CANDIDATES;
  const manifest = yield* readCanonicalManifest(profile, options.now, { limit, candidateIds: ids, excludeIds: currentReviewed });
  const rows = yield* validateReview(manifest, yield* decodeReview(review), options.now, profileMaxAge(profile.bundle));

  const summary = (status: CompletedReviewResult["status"], newlyReviewed: number): CompletedReviewResult => {
    const reviewedCount = manifest.reviewed_count + newlyReviewed;
    const remaining = manifest.eligible_count - reviewedCount;

    return { status, recorded_count: ids.length, eligible_count: manifest.eligible_count, reviewed_count: reviewedCount, remaining_count: remaining, batch_count: Math.ceil(remaining / limit), coverage_id: manifest.coverage_id, manifest_id: manifest.manifest_id };
  };

  const commit = (connection: JudgeConnectionHandle) => completionTransaction(connection, Effect.gen(function* () {
    const currentProfile = yield* freshJudgeProfile(context);
    const currentManifest = yield* readCanonicalManifest(currentProfile, options.now, { limit, candidateIds: ids });
    yield* validateReview(currentManifest, yield* decodeReview(review), options.now, profileMaxAge(currentProfile.bundle));

    if (currentManifest.manifest_id !== manifest.manifest_id) return yield* new JudgeStateError({ message: "Source/profile changed before review record" });

    const saved = yield* persistReviewedIds(connection, {
      manifest, raw_review: review, assessments: rows.map((row) => ({ id: row.id, version: row.version })), recorded_at: recordedAt,
    });

    return summary(saved.status, saved.newly_reviewed);
  }));

  return options.connection === undefined
    ? yield* Effect.scoped(Effect.flatMap(openJudgeConnection({ ...selected, readonly: false }, "completion-ledger"), commit))
    : yield* commit(options.connection);
}).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: cause.message, cause })));
