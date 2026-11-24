import { Data } from "effect";

export class DashboardError extends Data.TaggedError("DashboardError")<{
  readonly message: string;
}> {}
