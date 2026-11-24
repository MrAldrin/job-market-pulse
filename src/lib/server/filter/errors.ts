import { Data } from "effect";

export class FilterInputError extends Data.TaggedError("FilterInputError")<{
  readonly message: string;
}> {}

export class ScreenCompilationError extends Data.TaggedError("ScreenCompilationError")<{
  readonly message: string;
}> {}

export type FilterError = FilterInputError | ScreenCompilationError;
