import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import type { Digest, DigestRequest } from "../../contracts/select.ts";
import { parseRequestBytes, selectDigest, type DigestOptions } from "./core.ts";
import { DigestInputError } from "./errors.ts";
import { readBoundedFile } from "../shared/bounded-file.ts";

// Assessment transport belongs to the caller, not Judge's private store schema.
export class AssessmentRequests extends Context.Tag("pulse/AssessmentRequests")<AssessmentRequests, {
  readonly read: Effect.Effect<Uint8Array, DigestInputError>;
}>() {}

export const AssessmentRequestsFile = (path: string) => Layer.effect(AssessmentRequests, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return { read: readBoundedFile(path, 1_048_576).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(() => new DigestInputError({ message: "Digest input could not be read" }))) };
}));

export class DigestSelection extends Context.Tag("pulse/DigestSelection")<DigestSelection, {
  readonly request: Effect.Effect<DigestRequest, DigestInputError>;
  readonly select: (asOf: bigint, options?: DigestOptions) => Effect.Effect<Digest, DigestInputError>;
}>() {}

export const DigestSelectionLive = Layer.effect(DigestSelection, Effect.gen(function* () {
  const source = yield* AssessmentRequests;
  const request = source.read.pipe(Effect.flatMap(parseRequestBytes));

  return { request, select: (asOf, options) => request.pipe(Effect.flatMap((value) => selectDigest(value, asOf, options))) };
}));
