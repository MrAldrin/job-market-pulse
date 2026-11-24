import { Reactivity } from "@effect/experimental";
import { SqlClient, Statement } from "@effect/sql";
import type { Connection } from "@effect/sql/SqlConnection";
import type { SqlError } from "@effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Option, Scope } from "effect";
import { randomUUID } from "node:crypto";

// No result/query transforms or native-driver extension API on this boundary.
export type SqliteResourceConfig = Pick<SqliteClient.SqliteClientConfig, "filename" | "readonly" | "readwrite" | "create" | "spanAttributes">;

export interface SqliteResource extends SqlClient.SqlClient {
  readonly withConnection: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  readonly readSnapshot: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
}

// Acquisition is explicit and scoped. Never consume the driver's shared transaction tag.
export const acquireSqliteResource = (config: SqliteResourceConfig): Effect.Effect<SqliteResource, never, Scope.Scope | Reactivity.Reactivity> => Effect.gen(function* () {
  const driver = yield* SqliteClient.make({
    filename: config.filename, readonly: config.readonly, readwrite: config.readwrite,
    create: config.create, spanAttributes: config.spanAttributes, disableWAL: true,
  });

  const reactivity = yield* Reactivity.Reactivity;
  const transaction = Context.GenericTag<readonly [Connection, number]>(`pulse/sqlite-resource/${randomUUID()}`);
  const attributes: ReadonlyArray<readonly [string, unknown]> = [...Object.entries(config.spanAttributes ?? {}), ["db.system.name", "sqlite"]];
  const acquire = Effect.flatMap(Effect.serviceOption(transaction), (current) => Option.isSome(current) ? Effect.succeed(current.value[0]) : driver.reserve);

  // Depth -1 pins a connection without claiming an active SQL transaction.
  const withConnection: SqliteResource["withConnection"] = (program) => Effect.flatMap(Effect.serviceOption(transaction), (current) => Option.isSome(current) ? program
    : Effect.scoped(Effect.flatMap(driver.reserve, (connection) => program.pipe(Effect.provideService(transaction, [connection, -1])))));

  const execute = (connection: Connection, sql: string) => connection.executeUnprepared(sql, [], undefined).pipe(Effect.asVoid);

  const withTransaction = SqlClient.makeWithTransaction({
    transactionTag: transaction,
    spanAttributes: attributes,
    acquireConnection: Effect.flatMap(Scope.make(), (scope) => Scope.extend(driver.reserve, scope).pipe(Effect.map((connection) => [scope, connection] as const))),
    begin: (connection) => execute(connection, config.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE"),
    savepoint: (connection, id) => execute(connection, `SAVEPOINT effect_sql_${id}`),
    commit: (connection) => execute(connection, "COMMIT"),
    rollback: (connection) => execute(connection, "ROLLBACK"),
    rollbackSavepoint: (connection, id) => execute(connection, `ROLLBACK TO SAVEPOINT effect_sql_${id}`),
  });

  let snapshotId = 0;

  const readSnapshot: SqliteResource["readSnapshot"] = (program) => withConnection(Effect.gen(function* () {
    const current = yield* Effect.serviceOption(transaction);

    if (Option.isNone(current)) return yield* Effect.dieMessage("Missing selected SQLite reservation");
    const [connection, depth] = current.value;
    const name = `pulse_read_snapshot_${snapshotId++}`;

    return yield* Effect.acquireUseRelease(
      execute(connection, `SAVEPOINT ${name}`),
      () => program.pipe(Effect.provideService(transaction, [connection, Math.max(depth, 0)])),
      () => execute(connection, `ROLLBACK TO SAVEPOINT ${name}`).pipe(Effect.zipRight(execute(connection, `RELEASE SAVEPOINT ${name}`)), Effect.orDie),
    );
  }));

  // Check every added member; no driver statement closure is copied.
  const members: Omit<SqliteResource, keyof Statement.Constructor | "safe"> = {
    [SqlClient.TypeId]: SqlClient.TypeId,
    reserve: acquire,
    withTransaction,
    withConnection,
    readSnapshot,
    withoutTransforms: (): SqliteResource => client,
    reactive: reactivity.stream,
    reactiveMailbox: reactivity.query,
  };

  // SAFETY: All members are type-checked above; safe is set to this same client below. No data schema is asserted.
  const client = Object.assign(Statement.make(acquire, Statement.makeCompilerSqlite(), attributes, undefined), members) as SqliteResource;
  Object.defineProperty(client, "safe", { value: client, enumerable: true });

  return client;
});
