import { Data } from "effect";

export class ArtifactReadError extends Data.TaggedError("ArtifactReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export type ExampleError = ArtifactReadError;
