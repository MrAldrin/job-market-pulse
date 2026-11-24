import { Effect, Either, Schema } from "effect";
import { readApplicationDeadline, readHistoricalAd, readManifestSnapshot, readStatus, readVersion, sourceState, sourceTables } from "../source/readers.ts";
import { acquireStore, readSnapshot, type SourceSql } from "../source/store.ts";
import { isoInstant } from "./core.ts";
import type { DashboardSourceFacts, DashboardSourceValues } from "./dashboard.ts";
import { JudgeStateError } from "./errors.ts";
import { historicalRows } from "./history-context.ts";
import { sqlError, type JudgeSession } from "./session.ts";

export const historySourceListingIds = (session: JudgeSession) => Effect.gen(function* () {
  if (!session.initialized) return [];

  const staged = yield* session.sql<{ listing_id: string }>`SELECT DISTINCT listing_id FROM stage_results WHERE stage='full_review'`;
  const history = yield* Effect.forEach(yield* historicalRows(session), (row) => Either.mapLeft(Schema.decodeUnknownEither(Schema.Struct({ listing_id: Schema.String }))(row), (cause) => new JudgeStateError({ message: "Historical listing identity is invalid", cause })));

  return [...new Set([...staged, ...history].map((row) => row.listing_id))];
}).pipe(Effect.mapError(sqlError));

// Source owns all SQL and schema decoding. This adapter retains only facts used
// by Judge history policy and display, within the caller's selected snapshot.
export const collectHistorySourceFacts = (sql: SourceSql, listingIds: readonly string[]) => Effect.gen(function* () {
  const tables = yield* sourceTables(sql);
  const facts = new Map<string, DashboardSourceFacts>();

  for (const listingId of new Set(listingIds)) {
    const ad = tables.has("ads") ? yield* readHistoricalAd(sql, listingId) : null;
    let projected: DashboardSourceFacts["ad"] = null;

    if (ad !== null) {
      projected = { changed: ad.changed, expires: ad.expires };

      if (ad.title !== undefined) projected = { ...projected, title: ad.title };

      if (ad.employer !== undefined) projected = { ...projected, employer: ad.employer };

      if (ad.locations !== undefined) projected = { ...projected, locations: ad.locations };

      if (ad.detail_missing !== undefined) projected = { ...projected, detail_missing: Boolean(ad.detail_missing) };

      if (Object.hasOwn(ad, "application_due")) {
        const due = yield* Either.mapLeft(Schema.decodeUnknownEither(Schema.NullOr(Schema.String))(ad["application_due"]), (cause) => new JudgeStateError({ message: "Historical Source application deadline is invalid", cause }));
        projected = { ...projected, application_due: due };
      }
    }

    const status = tables.has("ad_status_evidence") ? yield* readStatus(sql, listingId) : null;
    const version = tables.has("versions") ? yield* readVersion(sql, listingId) : null;
    const deadline = tables.has("ad_application_deadlines") ? yield* readApplicationDeadline(sql, listingId) : null;
    facts.set(listingId, { ad: projected, status: status === null ? null : { status: status[0], changed: status[1] }, version, application_deadline: deadline === null ? null : { changed: deadline[0], value: deadline[1], rolling: Boolean(deadline[2]) } });
  }

  return facts;
});

const collectDashboardSource = (sql: SourceSql, listingIds: readonly string[]) => Effect.gen(function* () {
  const state = yield* sourceState(sql);
  const checked = state["checked"];

  if (checked === undefined) return yield* new JudgeStateError({ message: "Saved source check is missing" });

  return { checked_at: yield* isoInstant(checked), facts: yield* collectHistorySourceFacts(sql, listingIds) } satisfies DashboardSourceValues;
});

export const readDashboardSource = (path: string, listingIds: readonly string[]) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "readonly");

  return yield* readSnapshot(sql, collectDashboardSource(sql, listingIds));
})).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: "Cannot read selected Source history", cause })));

export const readDashboardSourceSnapshot = (path: string, listingIds: readonly string[], maxListings: number, now: string) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "readonly");

  return yield* readSnapshot(sql, Effect.gen(function* () {
    const history = yield* collectDashboardSource(sql, listingIds);
    const current = yield* Effect.either(readManifestSnapshot(sql, maxListings, now));

    return { history, current };
  }));
})).pipe(Effect.mapError((cause) => cause instanceof JudgeStateError ? cause : new JudgeStateError({ message: "Cannot read selected Source history", cause })));
