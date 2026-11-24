import { FileSystem } from "@effect/platform";
import { Reactivity } from "@effect/experimental";
import { Effect, Either, Option, Schema } from "effect";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProfileId } from "../../contracts/judge-state.ts";
import { JudgeStateError } from "./errors.ts";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";
import { initializeSchema, validateReadSchema } from "./schema.ts";
import type { JudgeSession } from "./session.ts";
import { sqlError } from "./session.ts";
import { verifyWindowsPrivateSqlite } from "../shared/windows-private-files.ts";

export const DatabaseSelection = Schema.Struct({
  profile_id: ProfileId,
  directory: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  readonly: Schema.Boolean,
  require_existing: Schema.Boolean,
});

export type DatabaseSelection = typeof DatabaseSelection.Type;

export interface JudgeDatabaseHandle extends JudgeSession {
  readonly sql: SqliteResource;
  readonly path: string;
  readonly existed: boolean;
}

export interface JudgeConnectionHandle extends Omit<JudgeSession, "initialized"> {
  readonly sql: SqliteResource;
  readonly path: string;
  readonly existed: boolean;
}

export const JudgeNamespace = Schema.Literal("personal-state", "completion-ledger");

export type JudgeNamespace = typeof JudgeNamespace.Type;

const sqliteOpenError = Schema.decodeUnknownOption(Schema.Struct({
  code: Schema.String.pipe(Schema.pattern(/^SQLITE_(?:CANTOPEN|PERM|AUTH|NOTADB|CORRUPT|IOERR|BUSY|LOCKED)(?:_[A-Z]+)?$/)),
}));

const accessFailure = (cause: unknown) => new JudgeStateError({ message: "Cannot safely open selected Judge state", cause });

// All paths come from the selected profile operation. Constructing the factory,
// importing it, or registering a Layer does not inspect any file or default DB.
export const openJudgeConnection = (selection: DatabaseSelection, namespace: JudgeNamespace) => Effect.gen(function* () {
  const selected = yield* Either.mapLeft(Schema.decodeUnknownEither(DatabaseSelection, { onExcessProperty: "error" })(selection), accessFailure);
  yield* Either.mapLeft(Schema.decodeUnknownEither(JudgeNamespace)(namespace), accessFailure);

  if (selected.readonly && selected.require_existing) {
    return yield* new JudgeStateError({ message: "Read-only mode already requires an existing DB" });
  }

  const directory = resolve(selected.directory);
  const path = resolve(selected.path);
  const remainder = relative(directory, path);

  if (!remainder || isAbsolute(remainder) || remainder === ".." || remainder.startsWith(".." + sep)) {
    return yield* new JudgeStateError({ message: "Personal state database escaped its profile" });
  }

  const fs = yield* FileSystem.FileSystem;

  const create = !selected.readonly && !selected.require_existing;
  const windows = process.platform === "win32";
  const existed = yield* (windows ? prepareWindowsState(directory, path, create) : preparePosixState(directory, path, create, namespace));
  const absentReader = selected.readonly && !existed;

  const sql = yield* acquireSqliteResource({
    filename: absentReader ? ":memory:" : path,
    readonly: selected.readonly && !absentReader,
    readwrite: !selected.readonly || absentReader,
    create: absentReader,
  }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.catchSomeDefect((cause) => Option.isSome(sqliteOpenError(cause))
      ? Option.some(Effect.fail(accessFailure(cause)))
      : Option.none()),
  );

  // PersonalState enables FK checks. The frozen standalone completion opener
  // leaves that connection setting at the driver's default; do not change a
  // held PersonalState resource when completion later shares its transaction.
  if (namespace === "personal-state") yield* sql`PRAGMA foreign_keys=ON`.pipe(Effect.mapError(sqlError));

  if (windows) yield* sql`PRAGMA temp_store=MEMORY`.pipe(Effect.mapError(sqlError));

  yield* sql`PRAGMA busy_timeout=5000`.pipe(Effect.mapError(sqlError));

  if (selected.readonly) yield* sql`PRAGMA query_only=ON`.pipe(Effect.mapError(sqlError));
  else {
    if (!windows) yield* fs.chmod(path, 0o600).pipe(Effect.mapError(accessFailure));
    yield* sql`PRAGMA synchronous=FULL`.pipe(Effect.mapError(sqlError));
  }

  // Acquisition never initializes a domain namespace. In particular, completion
  // must not create PersonalState tables before its real second validation.
  return { sql, path, profile_id: selected.profile_id, readonly: selected.readonly, existed } satisfies JudgeConnectionHandle;
});

const prepareWindowsState = (directory: string, path: string, create: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const verify = verifyWindowsPrivateSqlite(directory, path).pipe(Effect.mapError(accessFailure));
  const initial = yield* verify;

  if (create && !initial.existed) {
    if (initial.missingParent) {
      yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(Effect.mapError(accessFailure));
      const parent = yield* verify;

      if (parent.existed || parent.missingParent) return yield* accessFailure(undefined);
    }

    yield* Effect.scoped(fs.open(path, { flag: "wx" })).pipe(Effect.mapError(accessFailure));
    const created = yield* verify;

    if (!created.existed) return yield* accessFailure(undefined);
  }

  return initial.existed;
});

const preparePosixState = (directory: string, path: string, create: boolean, namespace: JudgeNamespace) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const inspect = (target: string) => fs.stat(target).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)),
    Effect.mapError(accessFailure),
  );

  const profileInfo = yield* inspect(directory);

  if (Option.isSome(profileInfo) && (profileInfo.value.type !== "Directory" || (profileInfo.value.mode & 0o077) !== 0)) {
    return yield* new JudgeStateError({ message: "Profile directory permissions or file kind are unsafe" });
  }

  if (create && Option.isNone(profileInfo)) {
    if (namespace === "completion-ledger") return yield* new JudgeStateError({ message: "Private profile directory is unavailable" });

    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(accessFailure));
  }

  const components = relative(directory, dirname(path)).split(sep).filter((part) => part.length > 0);
  let current = directory;

  // Validate intermediate directories for READERS and existing-only writers too.
  for (const part of components) {
    current = join(current, part);
    const info = yield* inspect(current);

    if (Option.isNone(info)) {
      if (create) yield* fs.makeDirectory(current, { mode: 0o700 }).pipe(Effect.mapError(accessFailure));
    } else if (info.value.type !== "Directory" || (info.value.mode & 0o077) !== 0) {
      return yield* new JudgeStateError({ message: "Personal state directory permissions or file kind are unsafe" });
    }
  }

  const databaseInfo = yield* inspect(path);

  if (Option.isSome(databaseInfo) && (databaseInfo.value.type !== "File" || (databaseInfo.value.mode & 0o077) !== 0)) {
    return yield* new JudgeStateError({ message: "Personal state database must be a private regular file" });
  }

  if (create) {
    if (Option.isNone(databaseInfo)) {
      // Exclusive creation fixes the mode before SQLite can create journals. It
      // does not change process-global umask or overwrite a racing existing file.
      yield* Effect.scoped(fs.open(path, { flag: "wx", mode: 0o600 })).pipe(Effect.mapError(accessFailure));
    }
  }

  return Option.isSome(databaseInfo);
});

export const openJudgeDatabase = (selection: DatabaseSelection) => Effect.gen(function* () {
  const connection = yield* openJudgeConnection(selection, "personal-state");

  const initialized = connection.readonly
    ? yield* validateReadSchema(connection.sql, connection.profile_id)
    : yield* Effect.as(initializeSchema(connection.sql, connection.profile_id), true);

  return { sql: connection.sql, path: connection.path, profile_id: connection.profile_id, readonly: connection.readonly, existed: connection.existed, initialized } satisfies JudgeDatabaseHandle;
});
