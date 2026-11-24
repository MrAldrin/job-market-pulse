import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Option } from "effect";
import { isAbsolute } from "node:path";
import { physicalPath } from "../shared/paths.ts";
import { SnapshotError } from "./errors.ts";

const suffixes = ["-wal", "-shm", "-journal"] as const;

export interface ProtectedSnapshotInput { readonly path: string; readonly database: boolean }

export class SnapshotPaths extends Context.Tag("pulse/SnapshotPaths")<SnapshotPaths, {
  readonly output: (path: string, protectedInputs: readonly ProtectedSnapshotInput[]) => Effect.Effect<string, SnapshotError>;
}>() {}

export const SnapshotPathsLive = Layer.effect(SnapshotPaths, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const canonical = (path: string) => physicalPath(path).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(() => new SnapshotError({ message: "Cannot resolve snapshot path" })));

  const fileIdentity = (path: string) => fs.stat(path).pipe(
    Effect.map((info) => Option.map(info.ino, (inode) => `${info.dev}:${inode}`)),
    Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)),
    Effect.mapError(() => new SnapshotError({ message: "Cannot inspect snapshot path" })),
  );

  return SnapshotPaths.of({
    output: (path, protectedInputs) => Effect.gen(function* () {
      if (!isAbsolute(path)) return yield* new SnapshotError({ message: "Snapshot output path must be absolute" });
      const output = yield* canonical(path);
      const writes = [output, ...suffixes.map((suffix) => output + suffix)];
      const outputIdentity = protectedInputs.length ? yield* fileIdentity(output) : Option.none();

      for (const input of protectedInputs) {
        const source = yield* canonical(input.path);
        const reads = input.database ? [source, ...suffixes.map((suffix) => source + suffix)] : [source];

        if (writes.some((target) => reads.includes(target))) return yield* new SnapshotError({ message: "Snapshot output aliases a protected input" });

        // A hard-linked backup is still the input database. Do not prune it.
        if (Option.isSome(outputIdentity)) {
          const inputIdentity = yield* fileIdentity(source);

          if (Option.contains(outputIdentity.value)(inputIdentity)) return yield* new SnapshotError({ message: "Snapshot output aliases a protected input" });
        }
      }

      return output;
    }),
  });
}));
