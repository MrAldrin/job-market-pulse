import { Reactivity } from "@effect/experimental";
import { Effect, Option, Schema } from "effect";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { decodeProfileId } from "../profile/core.ts";
import { ProfileFiles } from "../profile/files.ts";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";
import { verifyWindowsPrivateSqlite } from "../shared/windows-private-files.ts";
import { utcText } from "../source/core.ts";

const Stage = Schema.Literal("schedule", "lock", "preflight", "review-preflight", "pipeline", "sync-source", "resolve-locations", "review", "snapshot", "snapshot-export", "upload", "interrupted", "runner");
const isStage = Schema.is(Stage);

const errors = {
  schedule: "Schedule configuration is unavailable or invalid.",
  lock: "Another workflow holds the installation lock.",
  interrupted: "Scheduled refresh was interrupted.",
  runner: "Scheduled refresh could not finish.",
} satisfies Readonly<Partial<Record<Schema.Schema.Type<typeof Stage>, string>>>;

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const rowSchema = Schema.Struct({
  status: Schema.Literal("running", "ok", "failed"),
  started_at: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  failed_stage: Schema.NullOr(Stage),
  error: Schema.NullOr(Schema.String),
});

const isRow = Schema.is(rowSchema);
const isNullableText = Schema.is(Schema.NullOr(Schema.String));

export class ScheduledRunsError extends Schema.TaggedError<ScheduledRunsError>()("ScheduledRunsError", { message: Schema.String }) {}

const failure = () => new ScheduledRunsError({ message: "Scheduled-run history is unavailable or invalid" });
const io = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: failure });

export interface RunSummary {
  readonly status: "running" | "ok" | "failed";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly failed_stage: string | null;
  readonly error: string | null;
  readonly last_good_at: string | null;
}

// Callers supply a selected root and profile; no history is opened at registration.
export const scheduledRunPath = (root: string, profileId: string) => Effect.gen(function* () {
  yield* decodeProfileId(profileId);
  const files = yield* ProfileFiles;
  const path = join(root, "local_only", "profiles", profileId, "scheduled-runs.sqlite3");

  yield* files.check(root, path, "File");

  return path;
});

const prepare = (path: string, writer: boolean, create: boolean) => io(async () => {
  if (writer && process.platform !== "win32") await fs.chmod(dirname(path), 0o700);

  let file;

  try {
    file = await fs.open(path, (writer ? constants.O_RDWR | (create ? constants.O_CREAT : 0) : constants.O_RDONLY), 0o600);
  } catch (error) {
    if (!writer && missing(error)) return false;
    throw error;
  }

  try {
    const info = await file.stat();

    if (!info.isFile()) throw failure();

    if (writer && process.platform !== "win32") await file.chmod(0o600);
  } finally { await file.close(); }

  return true;
}).pipe(Effect.uninterruptible);

const withStore = <A, E, R>(root: string, profileId: string, writer: boolean, use: (sql: SqliteResource) => Effect.Effect<A, E, R>, create = writer) => Effect.scoped(Effect.gen(function* () {
  const path = yield* scheduledRunPath(root, profileId);
  const windows = process.platform === "win32";
  const verify = verifyWindowsPrivateSqlite(dirname(path), path).pipe(Effect.mapError(failure));
  const initial = windows ? yield* verify : null;

  if (!(yield* prepare(path, writer, create))) return null;

  if (initial !== null && !initial.existed && !(yield* verify).existed) return yield* failure();

  const sql = yield* acquireSqliteResource({ filename: path, readonly: !writer, readwrite: writer, create: false }).pipe(Effect.provide(Reactivity.layer), Effect.catchAllDefect(() => Effect.fail(failure())));

  yield* sql`PRAGMA busy_timeout = 5000`;

  if (writer && create) yield* sql`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL CHECK(status IN ('running','ok','failed')), failed_stage TEXT, error TEXT)`;

  return yield* use(sql);
}));

const awareTimestamp = (text: string) => Option.filter(parseIsoTime(text), (parsed) => parsed.aware);

const canonicalTimestamp = (text: string) => Effect.gen(function* () {
  const parsed = awareTimestamp(text);

  if (Option.isNone(parsed) || parsed.value.epochMicros < -62_135_596_800_000_000n || parsed.value.epochMicros >= 253_402_300_800_000_000n) return yield* failure();

  return utcText(parsed.value.epochMicros);
});

export const startScheduledRun = (root: string, profileId: string, now: string) => Effect.gen(function* () {
  const stamp = yield* canonicalTimestamp(now);

  return yield* withStore(root, profileId, true, (sql) => sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO runs(started_at, status) VALUES (${stamp}, 'running')`;
    const rows = yield* sql<{ id: number }>`SELECT last_insert_rowid() AS id`;
    const row = rows[0];

    if (!row) return yield* failure();

    return row.id;
  })));
});

export const finishScheduledRun = (root: string, profileId: string, runId: number, now: string, failedStage: string | null = null) => Effect.gen(function* () {
  const stamp = yield* canonicalTimestamp(now);
  const stage = failedStage === null ? null : isStage(failedStage) ? failedStage : "runner";
  const fixedErrors: Readonly<Partial<Record<Schema.Schema.Type<typeof Stage>, string>>> = errors;
  const error = stage === null ? null : fixedErrors[stage] ?? `Scheduled refresh stopped at ${stage}.`;
  const status = stage === null ? "ok" : "failed";

  // Finishing never initializes or recreates history. A missing intended row
  // must not turn a completed refresh into a success without saved history.
  return yield* withStore(root, profileId, true, (sql) => sql.withTransaction(Effect.gen(function* () {
    const rows = yield* sql<{ id: number }>`UPDATE runs SET ended_at=${stamp}, status=${status}, failed_stage=${stage}, error=${error} WHERE id=${runId} RETURNING id`;

    if (rows.length !== 1 || rows[0]?.id !== runId) return yield* failure();
  })), false);
});

export const latestScheduledRun = (root: string, profileId: string) => withStore(root, profileId, false, (sql) => sql.readSnapshot(Effect.gen(function* () {
  const rows = yield* sql`SELECT status, started_at, ended_at, failed_stage, error FROM runs ORDER BY id DESC LIMIT 1`;
  const good = yield* sql<{ ended_at: unknown }>`SELECT ended_at FROM runs WHERE status='ok' ORDER BY id DESC LIMIT 1`;
  const row = rows[0];
  const lastGood = good[0]?.ended_at ?? null;

  if (!row) return null;

  if (!isRow(row) || !isNullableText(lastGood)) return yield* failure();

  if (Option.isNone(awareTimestamp(row.started_at)) || (row.ended_at !== null && Option.isNone(awareTimestamp(row.ended_at)))
    || (lastGood !== null && Option.isNone(awareTimestamp(lastGood)))) return yield* failure();

  return { ...row, last_good_at: lastGood } satisfies RunSummary;
})));
