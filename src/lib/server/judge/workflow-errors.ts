import { Data } from "effect";

/** Stable workflow codes must not contain model output or private input. */
export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly code: string;
}> {}
