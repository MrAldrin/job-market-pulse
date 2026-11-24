import { Data } from "effect";

// Public failures omit file contents, narrative, lookup queries and provider bodies.
export class ProfileError extends Data.TaggedError("ProfileError")<{
  readonly message: string;
}> {}

export class PlaceLookupError extends Data.TaggedError("PlaceLookupError")<{
  readonly message: string;
}> {}

export class PostcodeAreaError extends Data.TaggedError("PostcodeAreaError")<{
  readonly message: string;
}> {}

export class PeriodError extends Data.TaggedError("PeriodError")<{
  readonly message: string;
}> {}

export type ProfileFailure = ProfileError | PlaceLookupError | PostcodeAreaError | PeriodError;
