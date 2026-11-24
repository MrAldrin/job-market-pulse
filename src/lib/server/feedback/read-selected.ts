import { Reactivity } from "@effect/experimental";
import { FileSystem } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Option } from "effect";
import { isAbsolute } from "node:path";
import { acquireSqliteResource, type SqliteResource } from "../shared/sqlite-resource.ts";

class FeedbackReadError extends Data.TaggedError("FeedbackReadError")<{ readonly message: string }> {}

const unavailable = () => new FeedbackReadError({ message: "Cannot read the selected feedback store" });

// Local exports use a normal readonly connection, with their own selection rules.
export const readSelectedFeedbackFile = <A, E>(path: string, read: (sql: SqliteResource) => Effect.Effect<readonly A[], E>) =>
  Effect.scoped(Effect.gen(function* () {
    if (!isAbsolute(path)) return yield* unavailable();
    const fs = yield* FileSystem.FileSystem;

    const info = yield* fs.stat(path).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)),
    );

    if (Option.isNone(info)) return [];

    if (info.value.type !== "File") return yield* unavailable();

    const sql = yield* acquireSqliteResource({ filename: path, readonly: true, readwrite: false, create: false }).pipe(
      Effect.provide(Reactivity.layer), Effect.catchAllDefect(() => Effect.fail(unavailable())),
    );

    return yield* sql.readSnapshot(read(sql)).pipe(Effect.provideService(SqlClient.SafeIntegers, true));
  })).pipe(
    Effect.catchSomeDefect((error) => error instanceof SqlError ? Option.some(Effect.fail(unavailable())) : Option.none()),
  );
