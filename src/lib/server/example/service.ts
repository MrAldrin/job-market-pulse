import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { artifactPresence } from "./core.ts";
import { ArtifactReadError } from "./errors.ts";

export class ArtifactProbe extends Context.Tag("pulse/ArtifactProbe")<ArtifactProbe, {
  readonly inspect: (path: string) => Effect.Effect<ReturnType<typeof artifactPresence>, ArtifactReadError>;
}>() {}

export const ArtifactProbeLive = Layer.effect(ArtifactProbe, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return {
    inspect: (path: string) => fs.exists(path).pipe(
      Effect.map(artifactPresence),
      Effect.mapError((cause) => new ArtifactReadError({ path, cause })),
    ),
  };
}));
