import type { SqlClient } from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { JudgeStateError } from "./errors.ts";

export interface JudgeSession {
  readonly sql: SqlClient;
  readonly profile_id: string;
  readonly readonly: boolean;
  readonly initialized: boolean;
}

export class JudgeIds extends Context.Tag("pulse/JudgeIds")<JudgeIds, {
  readonly next: Effect.Effect<string>;
}>() {}

export const JudgeIdsLive = Layer.succeed(JudgeIds, { next: Effect.sync(() => crypto.randomUUID()) });

export const decodeStored = <A, I, B>(schema: Schema.Schema<A, I>, value: B): Either.Either<A, JudgeStateError> =>
  Either.mapLeft(Schema.decodeUnknownEither(Schema.typeSchema(schema), { onExcessProperty: "error" })(value), (cause) =>
    new JudgeStateError({ message: "Invalid saved Judge state", cause }),
  );

export const sqlError = (cause: unknown): JudgeStateError => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: "Cannot access selected Judge state", cause });

export const requireInitialized = (session: JudgeSession): Effect.Effect<void, JudgeStateError> => session.initialized
  ? Effect.void
  : Effect.fail(new JudgeStateError({ message: "Personal state schema is not initialized" }));

export const write = <A, E, R>(session: Pick<JudgeSession, "sql" | "readonly">, effect: Effect.Effect<A, E, R>) => session.readonly
  ? Effect.fail(new JudgeStateError({ message: "Personal state is read-only" }))
  : session.sql.withTransaction(effect).pipe(Effect.mapError((cause) => cause instanceof SqlError ? sqlError(cause) : cause));
