import { Data } from "effect";

export class JudgeStateError extends Data.TaggedError("JudgeStateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type JudgeError = JudgeStateError;
