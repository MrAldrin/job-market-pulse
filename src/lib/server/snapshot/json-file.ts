import { FileSystem } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { dirname } from "node:path";
import { SnapshotDocument, decodeSnapshotDocumentBytes } from "../../contracts/snapshot.ts";
import { readBoundedFile } from "../shared/bounded-file.ts";
import { snapshotPrettyJson } from "./serialization.ts";
import { SnapshotError } from "./errors.ts";
import { SnapshotPaths } from "./paths.ts";

export class SnapshotJsonFile extends Context.Tag("pulse/SnapshotJsonFile")<SnapshotJsonFile, {
  readonly read: (path: string) => Effect.Effect<SnapshotDocument, SnapshotError>;
  readonly readOptional: (path: string) => Effect.Effect<SnapshotDocument | null, SnapshotError>;
  readonly write: (path: string, document: SnapshotDocument) => Effect.Effect<void, SnapshotError>;
}>() {}

export const SnapshotJsonFileLive = Layer.effect(SnapshotJsonFile, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* SnapshotPaths;

  const bytes = (path: string) => readBoundedFile(path, 8_000_000).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const readError = () => new SnapshotError({ message: "Cannot read snapshot JSON" });

  return SnapshotJsonFile.of({
    read: (path) => bytes(path).pipe(Effect.flatMap(decodeSnapshotDocumentBytes), Effect.mapError(readError)),
    readOptional: (path) => bytes(path).pipe(
      Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(null) : Effect.fail(error)),
      Effect.flatMap((value) => value === null ? Effect.succeed(null) : decodeSnapshotDocumentBytes(value)),
      Effect.mapError(readError),
    ),
    write: (path, document) => Effect.scoped(Effect.gen(function* () {
      yield* Schema.decodeUnknown(Schema.typeSchema(SnapshotDocument), { onExcessProperty: "error" })(document);
      const output = yield* paths.output(path, []);

      if (yield* fs.exists(output)) {
        const previous = yield* readBoundedFile(output, 8_000_000).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        const decoded = decodeSnapshotDocumentBytes(previous);

        if (Either.isLeft(decoded)) return yield* new SnapshotError({ message: "Existing JSON output is not a valid snapshot" });
      }

      yield* fs.makeDirectory(dirname(output), { recursive: true, mode: 0o700 });
      const temporary = yield* fs.makeTempFileScoped({ directory: dirname(output), prefix: ".snapshot-", suffix: ".tmp" });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.writeFileString(temporary, snapshotPrettyJson(document));
      yield* fs.rename(temporary, output);
    })).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot write snapshot JSON" }))),
  });
}));
