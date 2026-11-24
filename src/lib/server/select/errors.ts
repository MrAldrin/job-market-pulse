import { Data } from "effect";

export class DigestInputError extends Data.TaggedError("DigestInputError")<{
  readonly message: string;
}> {}

export class SelectResourceError extends Data.TaggedError("SelectResourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SelectError = DigestInputError | SelectResourceError;
