import { Schema } from "effect";
import { awareTimestamp } from "./support.ts";

export const stageNames = ["sync-source", "resolve-locations", "market", "review", "snapshot"] as const;
export const PipelineStageName = Schema.Literal(...stageNames);

export type StageName = typeof PipelineStageName.Type;

export const FinishedStageStatus = Schema.Literal("succeeded", "failed", "recorded", "skipped");

export const MarketRecording = Schema.Struct({
  captured_at: awareTimestamp,
  run_id: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/)),
});

export type MarketRecording = typeof MarketRecording.Type;

// Detail events carry counts and fixed identifiers, never stage output or prompts.
export type PipelineDetail =
  | { readonly kind: "nav-events"; readonly count: number }
  | { readonly kind: "eligible-jobs"; readonly count: number }
  | { readonly kind: "screened-out"; readonly count: number }
  | { readonly kind: "review-batch"; readonly step: "screen" | "judge" | "rejudge"; readonly batch: number; readonly count: number }
  | { readonly kind: "rejudge-started" };

export type PipelineProgress =
  | { readonly phase: "detail"; readonly detail: PipelineDetail }
  | { readonly phase: "attempt" }
  | { readonly phase: "started"; readonly stage: StageName }
  | { readonly phase: "finished"; readonly stage: StageName; readonly status: typeof FinishedStageStatus.Type; readonly marketRecording?: MarketRecording | undefined }
  | { readonly phase: "waiting"; readonly stage: StageName; readonly retryAt: string };
