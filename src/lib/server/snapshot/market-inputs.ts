import { Effect } from "effect";
import { resolve } from "node:path";
import type { ProfileBundle } from "../../contracts/profile.ts";
import { marketAds } from "../market/service.ts";
import { readHistoryFile } from "../market/history-store.ts";
import { loadTaxonomy } from "../market/taxonomy.ts";
import { readMarketSource, readSalarySource } from "../source/market-readers.ts";
import { acquireStore } from "../source/store.ts";
import { SnapshotError } from "./errors.ts";
import type { FrozenMarketAdmission } from "./service.ts";

// Source and Market own all SQL and classification. Snapshot selects only the
// frozen-history population for v1; current stock belongs to explicit v2.
const unavailable = () => new SnapshotError({ message: "Cannot read saved Source and Market snapshot facts" });

// Select and admit only enabled frozen Market history. Return the deferred
// store reads so a guarded caller can finish admission before SQLite opens.
export const prepareSnapshotMarketInputs = (profile: ProfileBundle, now: string, frozenPath: string | null, admit?: FrozenMarketAdmission) => Effect.gen(function* () {
  const taxonomy = yield* loadTaxonomy(resolve(profile.paths.directory, "../../.."));
  const selected = taxonomy.enabled && frozenPath !== null && admit !== undefined ? yield* admit(frozenPath) : frozenPath;

  return Effect.scoped(Effect.gen(function* () {
    const history = taxonomy.enabled ? yield* readHistoryFile(selected) : [];
    const source = yield* acquireStore(profile.paths.source_db, "readonly");

    const saved = yield* source.readSnapshot(Effect.gen(function* () {
      const ads = yield* readMarketSource(source, now);
      const salary = yield* readSalarySource(source);

      return { ads: marketAds(ads), salaries: salary.salaries };
    }));

    return { snapshots: history, taxonomy, ...saved };
  })).pipe(Effect.mapError(unavailable));
}).pipe(Effect.mapError(unavailable));

export const readSnapshotMarketInputs = (profile: ProfileBundle, now: string, frozenPath: string | null) =>
  prepareSnapshotMarketInputs(profile, now, frozenPath).pipe(Effect.flatten);
