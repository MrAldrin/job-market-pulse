import { Data } from "effect";

export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  readonly message: string;
}> {}
