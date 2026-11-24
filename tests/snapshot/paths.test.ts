import { BunContext } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SnapshotPaths, SnapshotPathsLive } from "../../src/lib/server/snapshot/paths.ts";

const layer = SnapshotPathsLive.pipe(Layer.provide(BunContext.layer));

const check = (output: string, input: string) => Effect.runPromise(Effect.gen(function* () {
  const paths = yield* SnapshotPaths;

  return yield* Effect.either(paths.output(output, [{ path: input, database: true }]));
}).pipe(Effect.provide(layer)));

it("rejects output paths that overlap a protected input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pulse-snapshot-paths-"));

  try {
    const input = join(directory, "source.sqlite3");
    await writeFile(input, "synthetic protected input");
    const output = join(directory, "snapshot.sqlite3");
    expect((await check(input, input))._tag).toBe("Left");
    expect((await check(output, input))._tag).toBe("Right");
    expect((await check(input + "-wal", input))._tag).toBe("Left");
    await link(input, output);
    expect((await check(output, input))._tag).toBe("Left");
    expect(await readFile(input, "utf8")).toBe("synthetic protected input");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

