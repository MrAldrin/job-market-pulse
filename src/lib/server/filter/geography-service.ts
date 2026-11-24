import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { decodeAreaExtents, GeographyError, normalizeName as frozenNormalizeName, type AreaExtent, type NormalizeName } from "./geography.ts";

export class GeographyAreas extends Context.Tag("pulse/GeographyAreas")<GeographyAreas, {
  readonly load: (path: string, normalizeName?: NormalizeName) => Effect.Effect<ReadonlyMap<string, AreaExtent>, GeographyError>;
}>() {}

export const GeographyAreasLive = Layer.effect(GeographyAreas, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cache = new Map<NormalizeName, Map<string, ReadonlyMap<string, AreaExtent>>>();

  return {
    load: (path: string, normalizeName: NormalizeName = frozenNormalizeName) => Effect.suspend(() => {
      const cached = cache.get(normalizeName)?.get(path);

      if (cached !== undefined) return Effect.succeed(cached);

      return fs.readFile(path).pipe(
        Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(null) : Effect.fail(error)),
        Effect.mapError((cause) => new GeographyError({ message: "Cannot read area extents", cause })),
        Effect.flatMap((bytes) => bytes === null ? Effect.succeed(new Map<string, AreaExtent>()) : Effect.try({
          // Retain a UTF-8 BOM so JSON parsing rejects it, as Python utf-8 does.
          try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          catch: (cause) => new GeographyError({ message: "Cannot decode area extents as UTF-8", cause }),
        }).pipe(Effect.flatMap((text) => decodeAreaExtents(text, normalizeName)))),
        // Like functools.cache, retain successful missing/empty results, but not
        // failed reads/decodes. The one application service owns this lifetime.
        Effect.tap((areas) => Effect.sync(() => {
          const paths = cache.get(normalizeName) ?? new Map<string, ReadonlyMap<string, AreaExtent>>();
          paths.set(path, areas);
          cache.set(normalizeName, paths);
        })),
      );
    }),
  };
}));
