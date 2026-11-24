import { Data } from "effect";

export class ReviewerError extends Data.TaggedError("ReviewerError")<{ readonly code: string }> {}
