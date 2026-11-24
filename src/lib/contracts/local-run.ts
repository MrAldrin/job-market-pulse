import { Schema } from "effect";
import { FinishedStageStatus, MarketRecording, PipelineStageName } from "./pipeline-progress.ts";
import { awareTimestamp } from "./support.ts";

export const localRunStartPath = "/app/run/start";
export const localRunStatusPath = "/app/run/status";

const ResetRunId = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/));

export const LocalRunStart = Schema.Struct({ confirm: Schema.Literal(true), reset_run_id: Schema.optional(ResetRunId) });

export const localRunLogLimit = 2_000;

export const LocalRunLogEntry = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.positive()),
  time: awareTimestamp,
  stage: Schema.NullOr(PipelineStageName),
  level: Schema.Literal("info", "warning", "error"),
  message: Schema.String,
});

export const LocalRunStatus = Schema.Struct({
  log: Schema.Array(LocalRunLogEntry).pipe(Schema.maxItems(localRunLogLimit)),
  status: Schema.Literal("idle", "running", "succeeded", "failed"),
  current_stage: Schema.NullOr(PipelineStageName),
  stages: Schema.Array(Schema.Struct({
    stage: PipelineStageName,
    status: Schema.Union(FinishedStageStatus, Schema.Literal("pending", "running", "waiting", "unknown")),
  })),
  last_market_recording: Schema.optional(MarketRecording),
  started_at: Schema.NullOr(Schema.String),
  ended_at: Schema.NullOr(Schema.String),
  retry_at: Schema.NullOr(Schema.String),
  reset_run_id: Schema.NullOr(ResetRunId),
  error: Schema.NullOr(Schema.String),
});

export type LocalRunStatus = typeof LocalRunStatus.Type;

export const LocalRunStatusResponse = Schema.extend(LocalRunStatus, Schema.Struct({
  csrf_token: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
}));
