import { FileSystem } from "@effect/platform";
import { Chunk, Effect, Stream } from "effect";

// Read only the limit plus one sentinel byte. Callers own their boundary's
// tagged error and must reject that sentinel-sized result before decoding.
export const readBoundedFile = (path: string, maxBytes: number) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const chunks = yield* Stream.runCollect(fs.stream(path, { bytesToRead: maxBytes + 1 }));
  const length = Chunk.reduce(chunks, 0, (total, chunk) => total + chunk.byteLength);
  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
});
