import { Data } from "effect";

export class SourceError extends Data.TaggedError("SourceError")<{
  readonly message: string;
  readonly code?: string;
  readonly transient?: boolean;
}> {}

export class ResolutionError extends Data.TaggedError("ResolutionError")<{
  readonly message: string;
}> {}

export class ObservationError extends Data.TaggedError("ObservationError")<{
  readonly message: string;
}> {}

export type SourceFailure = SourceError | ResolutionError;
