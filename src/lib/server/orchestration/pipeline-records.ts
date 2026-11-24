import { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { dirname } from "node:path";
import { ProfileFiles } from "../profile/files.ts";
import { parseJsonInput } from "../shared/json-input.ts";
import { decodeRunRecord, PipelineError, type RunRecord } from "./pipeline-core.ts";

// The caller holds the pipeline locks for the entire read/modify/write sequence.
export const pipelineRecords = (root: string, path: string, profileId: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const fs = yield* FileSystem.FileSystem;
  const failure = () => new PipelineError({ code: "record_io" });

  return {
    read: Effect.gen(function* () {
      if (!(yield* files.check(root, path, "File"))) return null;
      const text = yield* files.read(root, path, 64 * 1024);
      const parsed = yield* Either.mapLeft(parseJsonInput(text), () => new PipelineError({ code: "record_invalid" }));

      return yield* decodeRunRecord(parsed, profileId);
    }).pipe(Effect.mapError((error) => error instanceof PipelineError ? error : failure())),
    write: (record: RunRecord) => Effect.gen(function* () {
      const content = JSON.stringify(record) + "\n";

      if (yield* files.check(root, path, "File")) yield* files.replace(root, path, content);
      else {
        yield* files.create(root, path, content);
        const directory = yield* fs.open(dirname(path), { flag: "r" });
        yield* directory.sync;
      }
    }).pipe(Effect.scoped, Effect.uninterruptible, Effect.mapError(failure)),
  };
});
