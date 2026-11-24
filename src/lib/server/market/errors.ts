import { Data, Effect, Either, Schema } from "effect";

export class MarketError extends Data.TaggedError("MarketError")<{
  readonly message: string;
}> {}

// The native driver can throw on open. Only known filesystem/SQLite failures are expected.
export const marketOpenFailure = (cause: unknown) => {
  const parsed = Schema.decodeUnknownEither(Schema.Struct({ code: Schema.String }))(cause);
  const code = Either.isRight(parsed) ? parsed.right.code : undefined;

  return code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY" || code === "EACCES" || code === "ENOENT" || code === "SQLITE_NOTADB"
    ? Effect.fail(new MarketError({ message: "Market database is unavailable" })) : Effect.die(cause);
};
