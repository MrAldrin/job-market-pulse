import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import type { ReviewEnvelope } from "../../contracts/fit-review.ts";
import { readBoundedFile } from "../shared/bounded-file.ts";
import { FilterInputError } from "./errors.ts";
import { decodeReviewBytes } from "./review.ts";

export class FitReviewFiles extends Context.Tag("pulse/FitReviewFiles")<FitReviewFiles, {
  readonly read: (path: string) => Effect.Effect<ReviewEnvelope, FilterInputError>;
}>() {}

export const FitReviewFilesLive = Layer.effect(FitReviewFiles, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return { read: (path: string) => readBoundedFile(path, 2_000_000).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.mapError(() => new FilterInputError({ message: "Review input could not be read" })),
    Effect.flatMap(decodeReviewBytes),
  ) };
}));
