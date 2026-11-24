import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Layer } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { preflightDemo } from "../../src/cli/demo-preflight.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { decodeSnapshotBytes, decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import { snapshotJsonBytes } from "../../src/lib/server/snapshot/serialization.ts";
import { demoSnapshot } from "../../src/cli/demo-snapshot.ts";
import example from "../../contracts/fixtures/snapshot.example.json";
import noBuild from "../oracle/basic-run/cli/operations/demo-no-build.json";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join("contracts", "fixtures", "snapshot.example.json");
const layers = ProfileFilesLive.pipe(Layer.provideMerge(BunFileSystem.layer));

const withCheckout = <A, E>(run: (root: string, resourceChecks: string[], contentReads: string[]) => Effect.Effect<A, E, FileSystem.FileSystem | ProfileFiles>) =>
  Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* ProfileFiles;
    const root = yield* fs.makeTempDirectoryScoped();
    const resourceChecks: string[] = [];
    const contentReads: string[] = [];
    yield* fs.makeDirectory(join(root, "build"));
    yield* fs.makeDirectory(join(root, "contracts", "fixtures"), { recursive: true });

    return yield* run(root, resourceChecks, contentReads).pipe(
      Effect.provideService(ProfileFiles, {
        ...files,
        root: (requested) => Effect.sync(() => {
          expect(requested).toBe(checkout);

          return root;
        }),
        check: (physicalRoot, path, kind) => Effect.sync(() => { resourceChecks.push(path); }).pipe(Effect.zipRight(files.check(physicalRoot, path, kind))),
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stream: (path, options) => {
          contentReads.push(path);

          return fs.stream(path, options);
        },
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(layers)));

const build = (root: string) => Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.writeFileString(join(root, "build", "index.js"), 'throw new Error("Demo preflight must not execute this file");\n'));

const refused = (stderr: string) => ({ kind: "blocked", exitStatus: 1, stdout: "", stderr: stderr + "\n" });

test("checks the build first and preserves the no-build result with truthful instructions", () => withCheckout((root, checks, reads) => Effect.gen(function* () {
  const result = yield* preflightDemo;
  expect(result).toEqual({
    kind: "blocked", exitStatus: noBuild.exit_status, stdout: noBuild.stdout,
    stderr: noBuild.stderr.replace("Run: pulse dashboard-build", "Run from the checkout root: bun run build"),
  });
  expect(checks).toEqual([join(root, "build", "index.js")]);
  expect(reads).toEqual([]);
})));

test("accepts the tracked invented fixture with the owning contract and never reads the build's bytes", () => withCheckout((root, checks, reads) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const snapshotPath = join(root, fixture);
  const buildEntry = join(root, "build", "index.js");
  yield* build(root);
  yield* fs.copyFile(join(checkout, fixture), snapshotPath);

  expect(yield* preflightDemo).toEqual({ kind: "validated", example });
  expect(checks).toEqual([buildEntry, snapshotPath]);
  expect(reads).toEqual([snapshotPath]);
})));

test("makes a valid v6 demo with recent jobs and distances at different launch dates", () => {
  const template = Either.getOrThrow(decodeSnapshotBytes(readFileSync(join(checkout, fixture))));

  for (const stamp of ["2027-01-01T10:00:00.000Z", "2028-02-29T23:59:00.000Z"]) {
    const now = Date.parse(stamp);
    const demo = demoSnapshot(template, now);
    expect(Either.isRight(decodeSnapshotDocumentBytes(snapshotJsonBytes(demo)))).toBe(true);
    expect(demo.generated_at).toBe(stamp);
    expect(demo.source.checked_at).toBe(stamp);
    expect(demo.market?.monthly.periods.at(-1)?.label).toBe(stamp.slice(0, 7));
    const jobs = demo.shortlist.job_ids.map((id) => demo.jobs.find((job) => job.id === id));
    expect(jobs.map((job) => job?.distance_km)).toEqual([6, 18, 26, null, 8, 27]);
    expect(jobs.slice(0, 2).map((job) => now - Date.parse(job?.first_found_at ?? "")))
      .toEqual([2 * 86_400_000, 7 * 86_400_000]);
  }

  expect(template.schema_version).toBe(1);
  expect(template.generated_at).toBe(example.generated_at);
});

test("fails safely for a missing or invalid invented fixture and does not print its bytes", () => withCheckout((root) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* build(root);
  expect(yield* preflightDemo).toEqual(refused("The invented-job fixture is missing from this checkout."));
  yield* fs.writeFileString(join(root, fixture), '{"schema":"pulse.snapshot","invented-private":"not for output"}');
  expect(yield* preflightDemo).toEqual(refused("The invented-job fixture does not pass the snapshot contract."));
})));

test("does not start with directories in place of the build or snapshot file", () => withCheckout((root, checks, reads) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const buildEntry = join(root, "build", "index.js");
  yield* fs.makeDirectory(buildEntry);
  expect(yield* preflightDemo).toEqual(refused("The dashboard is not built. Run from the checkout root: bun run build"));
  expect(checks).toEqual([buildEntry]);
  yield* fs.remove(buildEntry, { recursive: true });
  yield* build(root);
  yield* fs.makeDirectory(join(root, fixture));
  expect(yield* preflightDemo).toEqual(refused("Cannot read the invented-job fixture safely."));
  expect(reads).toEqual([]);
})));
