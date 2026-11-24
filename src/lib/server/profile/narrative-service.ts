import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { parse, resolve } from "node:path";
import { ProfileFiles, ProfileFilesLive } from "./files.ts";
import { ProfileError } from "./errors.ts";
import { decodeQuestions, type Question } from "./narrative.ts";
import { decodeCatalog, type OccupationBox } from "./occupation-catalog.ts";
import { decodeSuggestions, type Suggestions } from "./suggestions.ts";

export interface NarrativeResourcePaths {
  readonly template: string;
  readonly questions: string;
  readonly catalog: string;
  readonly suggestions?: string;
}

export class NarrativeResources extends Context.Tag("pulse/NarrativeResources")<NarrativeResources, {
  readonly template: Effect.Effect<string, ProfileError>;
  readonly questions: (short?: boolean) => Effect.Effect<readonly Question[], ProfileError>;
  readonly catalog: Effect.Effect<readonly OccupationBox[], ProfileError>;
  readonly suggestions: Effect.Effect<Suggestions, ProfileError>;
}>() {}

// Paths come from the caller's trusted resource selection. This service never writes files.
export const narrativeResourcesLayer = (paths: NarrativeResourcePaths) => Layer.effect(NarrativeResources, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const read = (path: string) => fs.readFile(path).pipe(
    Effect.mapError(() => new ProfileError({ message: "Cannot read profile resource" })),
    Effect.flatMap((bytes) => Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => new ProfileError({ message: "Cannot decode profile resource" }),
    })),
  );

  return {
    template: read(paths.template),
    questions: (short = false) => read(paths.questions).pipe(Effect.flatMap((text) => decodeQuestions(text, short))),
    catalog: read(paths.catalog).pipe(Effect.flatMap(decodeCatalog)),
    suggestions: Effect.gen(function* () {
      if (paths.suggestions === undefined) return yield* new ProfileError({ message: "No profile suggestions file is selected" });
      const files = yield* ProfileFiles;
      const path = resolve(paths.suggestions);

      return yield* files.read(parse(path).root, path, 100_000).pipe(Effect.flatMap(decodeSuggestions));
    }).pipe(Effect.provide(ProfileFilesLive), Effect.provideService(FileSystem.FileSystem, fs)),
  };
}));
