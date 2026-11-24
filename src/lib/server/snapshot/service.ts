import { Clock, Context, Effect, Layer, Schema } from "effect";
import { join, resolve } from "node:path";
import type { ProfileBundle } from "../../contracts/profile.ts";
import type { SnapshotPersonalInputs, SnapshotSettingsV4 } from "../../contracts/snapshot-settings.ts";
import { SnapshotV3, SnapshotV6, type SnapshotDocument } from "../../contracts/snapshot.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { Market } from "../market/service.ts";
import { buildSnapshot } from "./core.ts";
import { SnapshotError } from "./errors.ts";
import type { SnapshotInputs } from "./inputs.ts";
import { snapshotV2 } from "./market-history.ts";

const decodeSettingsSnapshot = decodeStrict(Schema.typeSchema(Schema.Union(SnapshotV3, SnapshotV6)));

export type FrozenMarketAdmission = (path: string) => Effect.Effect<string | null, SnapshotError>;

// The accepted Judge adapter supplies saved facts. Tests can supply frozen
// upstream values now; no SQL schema or Judge contract is duplicated here.
export class SnapshotFacts extends Context.Tag("pulse/SnapshotFacts")<SnapshotFacts, {
  readonly load: (profile: ProfileBundle, now: string, frozenMarketPath: string | null, admitFrozenMarket?: FrozenMarketAdmission) => Effect.Effect<SnapshotInputs, SnapshotError>;
}>() {}

export interface SnapshotBuildOptions {
  readonly now?: string;
  readonly version?: 1 | 2;
  /** Captured settings select v3; adding personal inputs selects v6. */
  readonly settings?: SnapshotSettingsV4;
  readonly personalInputs?: SnapshotPersonalInputs;
  /** Present only for a normal refresh with a successful source read. */
  readonly navEvents?: number | undefined;
  readonly frozenMarketPath?: string | null;
  /** Optional file admission for the frozen v1 export only. */
  readonly admitFrozenMarket?: FrozenMarketAdmission;
}

export class SnapshotExport extends Context.Tag("pulse/SnapshotExport")<SnapshotExport, {
  readonly build: (profile: ProfileBundle, options?: SnapshotBuildOptions) => Effect.Effect<SnapshotDocument, SnapshotError>;
}>() {}

export const SnapshotExportLive = Layer.effect(SnapshotExport, Effect.gen(function* () {
  const facts = yield* SnapshotFacts;
  const market = yield* Market;

  return SnapshotExport.of({
    build: (profile, options = {}) => Effect.gen(function* () {
      if (options.settings !== undefined && options.version !== undefined) return yield* new SnapshotError({ message: "Settings capture cannot select a legacy snapshot version" });

      if (options.personalInputs !== undefined && options.settings === undefined) return yield* new SnapshotError({ message: "Personal inputs require captured settings" });

      if (options.navEvents !== undefined && options.personalInputs === undefined) return yield* new SnapshotError({ message: "Run counts require a full snapshot" });

      if ((options.version === 2 || options.settings !== undefined) && options.admitFrozenMarket !== undefined) {
        return yield* new SnapshotError({ message: "Frozen Market admission is available only for v1 export" });
      }

      const now = options.now ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      const frozen = options.frozenMarketPath === undefined ? join(resolve(profile.paths.directory, "../../.."), "data/market.sqlite3") : options.frozenMarketPath;
      const inputs = yield* (options.admitFrozenMarket === undefined ? facts.load(profile, now, frozen) : facts.load(profile, now, frozen, options.admitFrozenMarket));

      if (inputs.profile.id !== profile.profile_id || inputs.profile.mode !== profile.policy.mode || inputs.now !== now) return yield* new SnapshotError({ message: "Saved snapshot facts do not match the selected profile and clock" });
      const snapshot = yield* buildSnapshot(inputs).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot build snapshot from saved facts" })));

      if (options.settings !== undefined) {
        if (options.personalInputs === undefined) {
          const { rejudge: _rejudge, ...settings } = options.settings;

          return yield* Effect.mapError(decodeSettingsSnapshot({ ...snapshot, schema_version: 3, settings }), () => new SnapshotError({ message: "Cannot build snapshot with captured settings" }));
        }

        const history = new Map([...inputs.judge.ranked, ...inputs.judge.closed].map((candidate) => [candidate.listing_id, candidate.rejudge]));

        const jobs = snapshot.jobs.map((job) => {
          const repeat = history.get(job.id);

          if (repeat === undefined) return job;
          const { reviewed_at, ...rejudge } = repeat;

          return { ...job, reviewed_at, rejudge };
        });

        const base = { ...snapshot, jobs, settings: options.settings, personal_inputs: options.personalInputs };
        const runPool = inputs.judge.runPool;

        const pool = runPool == null ? null : {
          filters: runPool.filters, screen: runPool.screen, judge: runPool.judge, waiting: runPool.waiting, failed: runPool.failed,
          listed_review_ids: jobs.filter((job) => job.result_id !== null && runPool.reviewResults.get(job.id) === job.result_id).map((job) => job.id),
        };

        const run_funnel = options.navEvents === undefined ? null : { nav_events: options.navEvents, pool };
        const distances = inputs.judge.distances;

        const document = decodeSettingsSnapshot({
          ...base, schema_version: 6, run_funnel, jobs: jobs.map((job) => ({ ...job, distance_km: distances?.get(job.id) ?? null })),
        });

        return yield* Effect.mapError(document, () => new SnapshotError({ message: "Cannot build snapshot with captured settings" }));
      }

      if (options.version !== 2) return snapshot;

      const history = inputs.market.taxonomy.enabled
        ? yield* market.readHistory(profile, frozen).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot read snapshot Market history" })))
        : null;

      return yield* snapshotV2(snapshot, history).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot build snapshot v2 Market history" })));
    }),
  });
}));
