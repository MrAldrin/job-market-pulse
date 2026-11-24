import { Effect, Either, Schema } from "effect";
import { Label } from "../../contracts/judge-state.ts";
import { boundedInteger } from "../../contracts/support.ts";
import { PythonFloat, type PythonJson } from "../shared/python-json.ts";
import { strip } from "../shared/text.ts";
import { normalizeIdentity, utcText } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { decodeStored, sqlError, write, type JudgeSession } from "./session.ts";

const ModelStep = Schema.Literal("screen", "judge", "rejudge", "calibrate");
const Labels = Schema.Struct({ harness: Label, provider: Label, model: Label, effort: Label });
const Count = boundedInteger(0, 1_000_000);
const TokenCount = Schema.NullOr(Schema.Union(Count, Schema.typeSchema(Count)));

const WallTime = Schema.NullOr(Schema.transform(
  Schema.Union(Schema.Number, Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(0n, 9_223_372_036_854_775_807n)), Schema.instanceOf(PythonFloat)),
  Schema.Number.pipe(Schema.finite(), Schema.greaterThanOrEqualTo(0)),
  { strict: true, decode: (value) => value instanceof PythonFloat ? value.value : Number(value), encode: (value) => value },
));

export type ModelCallLabels = typeof Labels.Type;

export interface ModelCallUsage {
  readonly input_tokens: PythonJson;
  readonly output_tokens: PythonJson;
  readonly wall_time_seconds: PythonJson;
}

export const beginModelCall = (session: JudgeSession, attemptId: string, step: string, labels: ModelCallLabels, now: bigint) => Effect.gen(function* () {
  yield* Either.mapLeft(Schema.decodeUnknownEither(ModelStep)(step), (cause) => new JudgeStateError({ message: "Invalid model step", cause }));
  const reviewer = yield* Either.mapLeft(Schema.decodeUnknownEither(Labels, { onExcessProperty: "error" })(labels), (cause) => new JudgeStateError({ message: "model call label must be bounded plain text", cause }));

  yield* write(session, Effect.gen(function* () {
    const selected = yield* normalizeIdentity(attemptId);
    const rows = yield* session.sql<{ run_id: string; status: string }>`SELECT run_id,status FROM stage_attempts WHERE attempt_id=${selected}`;
    const attempt = rows[0];

    if (!attempt || attempt.status !== "running") return yield* new JudgeStateError({ message: "Model call needs a running attempt" });

    // Frozen selection normalizes the lookup, but INSERT keeps the supplied ID.
    // A noncanonical alias therefore fails its FK; it is not silently rewritten.
    yield* session.sql`INSERT INTO model_call_log (attempt_id,run_id,step,harness,provider,model,effort,started_at) VALUES (${attemptId},${attempt.run_id},${step},${strip(reviewer.harness)},${strip(reviewer.provider)},${strip(reviewer.model)},${strip(reviewer.effort)},${yield* utcText(now)})`;
  }));
}).pipe(Effect.mapError(sqlError));

export const finishModelCall = (session: JudgeSession, attemptId: string, usage: ModelCallUsage) => Effect.gen(function* () {
  const wall = yield* Either.mapLeft(Schema.decodeUnknownEither(WallTime)(usage.wall_time_seconds), (cause) => new JudgeStateError({ message: "Invalid model wall time", cause }));

  yield* write(session, Effect.gen(function* () {
    const input = yield* Either.mapLeft(Schema.decodeUnknownEither(TokenCount)(usage.input_tokens), (cause) => new JudgeStateError({ message: "Invalid model token count", cause }));
    const output = yield* Either.mapLeft(Schema.decodeUnknownEither(TokenCount)(usage.output_tokens), (cause) => new JudgeStateError({ message: "Invalid model token count", cause }));
    const selected = yield* normalizeIdentity(attemptId);
    const updated = yield* session.sql`UPDATE model_call_log SET input_tokens=${input},output_tokens=${output},wall_time_seconds=${wall} WHERE attempt_id=${selected} RETURNING attempt_id`;

    if (updated.length !== 1) return yield* new JudgeStateError({ message: "Model call log is missing" });
  }));
}).pipe(Effect.mapError(sqlError));

const ModelCallRow = Schema.Struct({
  attempt_id: Schema.String,
  run_id: Schema.String,
  step: Schema.String,
  harness: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  started_at: Schema.String,
  input_tokens: Schema.NullOr(Schema.Number),
  output_tokens: Schema.NullOr(Schema.Number),
  wall_time_seconds: Schema.NullOr(Schema.Number),
});

export const modelCallLog = (session: JudgeSession, runId: string) => Effect.gen(function* () {
  const exists = yield* session.sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_call_log'`;

  if (exists.length === 0) return [];

  const rows = yield* session.sql`SELECT * FROM model_call_log WHERE run_id=${runId} ORDER BY started_at,attempt_id`;
  const saved = yield* decodeStored(Schema.Array(ModelCallRow), rows);

  // SQLite REAL values are Python floats even when mathematically integral.
  return saved.map((row) => ({ ...row, wall_time_seconds: row.wall_time_seconds === null ? null : new PythonFloat(row.wall_time_seconds) }));
}).pipe(Effect.mapError(sqlError));
