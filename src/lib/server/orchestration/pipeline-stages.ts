import { FileSystem } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { join } from "node:path";
import type { PipelineProgress } from "../../contracts/pipeline-progress.ts";
import { integerToken } from "../../contracts/support.ts";
import { loadTitleEvidence } from "../filter/evidence-pack.ts";
import { GeographyAreas } from "../filter/geography-service.ts";
import { FilterResources } from "../filter/service.ts";
import { SourcePolicies } from "../filter/source-policy.ts";
import { Market } from "../market/service.ts";
import type { LoadedProfile } from "../profile/service.ts";
import { parseJsonInput } from "../shared/json-input.ts";
import { SourceError } from "../source/errors.ts";
import { readLocationCheckpoint, saveLocationCheckpoint } from "../source/resources.ts";
import { Source } from "../source/service.ts";
import { type StageResult } from "./pipeline-core.ts";
import type { PipelineStage } from "./pipeline-runner.ts";

const sourceFailure = (error: SourceError): StageResult => ({
  returncode: error.transient || error.code === "busy" ? 75 : 1,
  stdout: "", stderr: error.message,
});

const isResolutionSummary = (output: string): boolean => {
  const value = parseJsonInput(output);

  return Either.isRight(value) && Either.isRight(Schema.decodeUnknownEither(Schema.Struct({ attempted: integerToken }))(value.right));
};

// These are real accepted Source, Filter and Market services. Review and
// Snapshot stages are composed only from their accepted owning services.
export const collectionStages = (root: string, selected: () => LoadedProfile, report?: (event: PipelineProgress) => Effect.Effect<void>, saveNavEvents?: (count: number) => void) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* Source;
  const policies = yield* SourcePolicies;
  const geography = yield* GeographyAreas;
  const resources = yield* FilterResources;
  const market = yield* Market;

  const policy = () => Effect.gen(function* () {
    const current = selected();
    const areas = yield* geography.load(resources.areaExtentsPath);

    const evidence = yield* loadTitleEvidence(root).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    return yield* policies.fromSettings(current.settings, areas, undefined, evidence);
  });

  const stages: readonly PipelineStage[] = [
    {
      name: "sync-source", timeoutMillis: 300_000,
      run: () => Effect.gen(function* () {
        const current = selected();
        const rules = yield* policy();

        return yield* source.syncPipeline(current.bundle.paths.source_db, rules).pipe(
          Effect.tap(({ events }) => Effect.sync(() => saveNavEvents?.(events)).pipe(
            Effect.zipRight(report?.({ phase: "detail", detail: { kind: "nav-events", count: events } }) ?? Effect.void),
          )),
          Effect.map((result) => ({ returncode: 0, stdout: JSON.stringify(result), stderr: "" })),
          Effect.catchAll((error) => Effect.succeed(sourceFailure(error))),
        );
      }),
    },
    {
      name: "resolve-locations", timeoutMillis: 300_000, validOutput: isResolutionSummary,
      run: () => Effect.gen(function* () {
        const current = selected();
        const rules = yield* policy();
        const checkpoint = join(current.bundle.paths.directory, "location-resolution.json");
        const after = yield* readLocationCheckpoint(checkpoint).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        const options = { limit: 10, checkpoint: (id: string) => saveLocationCheckpoint(checkpoint, id).pipe(Effect.provideService(FileSystem.FileSystem, fs)) };

        return yield* source.resolve(current.bundle.paths.source_db, rules, after === null ? options : { ...options, after }).pipe(
          Effect.map((result) => ({ returncode: 0, stdout: JSON.stringify(result), stderr: "" })),
          Effect.catchAll((error) => Effect.succeed(sourceFailure(error))),
        );
      }),
    },
    {
      name: "market", timeoutMillis: 300_000,
      run: () => Effect.gen(function* () {
        const current = selected();
        const result = yield* market.recordMarketSnapshot(current.bundle, current.settings);

        // No text is fetched for this step. The owner records truthful X/Y and
        // K/Y coverage, including zero text coverage when none was supplied.
        return { returncode: 0, stdout: "", stderr: "", market: result };
      }),
    },
  ];

  return stages;
});
