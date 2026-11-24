import { Data } from "effect";

// Never attach paths, payloads, destinations, SQL errors or transport exceptions.
export class AlertError extends Data.TaggedError("AlertError")<{ readonly code: string }> {}
