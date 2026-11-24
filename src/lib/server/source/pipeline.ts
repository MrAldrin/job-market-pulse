import { Effect, Either, Predicate, Schema } from "effect";
import { InsideJob, LocationCandidate, LocationEvidenceRefresh, OccupationRefresh, RankedMissingAd, type FilterSourcePolicy, type SourceFilterSnapshot } from "../../contracts/source.ts";
import { SourceAd } from "../../contracts/source-readers.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { asObject, MAX_DETAILS, occupationRecords, ORIGIN, sourceJson, statuses, timestamp, type SourceObject } from "./core.ts";
import { SourceError } from "./errors.ts";
import { applyEntry, closeAdText, recordApplicationDue, recordSourceStatus, replaceOccupations, storeDetailText, wallTimestamp, type IngestRules } from "./ingestion.ts";
import { monotonicMillis, type NavSession } from "./nav-client.ts";
import { currentOccupationPairs, readRelevance } from "./readers.ts";
import type { SourceSql } from "./store.ts";

const decode = <A, I, V>(schema: Schema.Schema<A, I>, value: V) => Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(() => new SourceError({ message: "Invalid Source pipeline data" })));

const filterOutput = <A, I>(schema: Schema.Schema<A, I>, rows: readonly SourceAd[], get: () => I) => Effect.try({ try: get, catch: () => new SourceError({ message: "Filter policy failed" }) }).pipe(Effect.flatMap((result) => decode(schema, result)), Effect.tap((result) => {
  if (!Array.isArray(result)) return Effect.fail(new SourceError({ message: "Invalid Filter policy output" }));

  const known = new Set(rows.map((row) => row.uuid));
  const seen = new Set<string>();

  for (const item of result) {
    const candidate = Schema.decodeUnknownEither(Schema.Struct({ uuid: Schema.String }))(item);

    if (Either.isLeft(candidate) || !known.has(candidate.right.uuid) || seen.has(candidate.right.uuid)) return Effect.fail(new SourceError({ message: "Invalid Filter policy identity" }));
    seen.add(candidate.right.uuid);
  }

  return Effect.void;
}));

export const filterSnapshot = (sql: SourceSql, now: string) => Effect.gen(function* () {
  const snapshot = yield* readRelevance(sql, now);

  return { ...snapshot, occupation_pairs: yield* currentOccupationPairs(sql) } satisfies SourceFilterSnapshot;
});

const rotate = <A extends { readonly uuid: string }>(rows: readonly A[], after: string | undefined): readonly A[] => {
  const index = rows.findIndex((row) => row.uuid === after);

  return index < 0 ? rows : [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
};

const refreshEntry = (row: SourceAd) => Effect.gen(function* () {
  const locations = yield* sourceJson(row.locations);

  if (!Array.isArray(locations)) return yield* new SourceError({ message: "Invalid saved locations" });

  return { id: "", url: ORIGIN + "/api/v1/feedentry/" + row.uuid, _feed_entry: {
    uuid: row.uuid, status: "ACTIVE", sistEndret: row.changed, title: row.title,
    businessName: row.employer, municipal: locations[0] ?? "",
  } } satisfies SourceObject;
});

export const refreshMissing = (sql: SourceSql, client: NavSession, policy: FilterSourcePolicy, rules: IngestRules, graceDays = 0) => Effect.gen(function* () {
  const rows = yield* decode(Schema.Array(SourceAd), yield* sql`SELECT * FROM ads WHERE detail_missing=1`);
  const ranked = yield* filterOutput(Schema.Array(RankedMissingAd), rows, () => policy.rankMissing(rows));
  const byId = new Map(rows.map((row) => [row.uuid, row]));
  const sorted = [...ranked].sort((a, b) => b.interest_score - a.interest_score || codepointOrder(a.uuid, b.uuid));
  const cursor = (yield* sql<{ value: string }>`SELECT value FROM state WHERE key='detail_cursor'`)[0]?.value;
  let refreshed = 0;

  for (const job of rotate(sorted, cursor)) {
    if (client.details_remaining <= 0 || client.remaining <= 1) break;

    const row = byId.get(job.uuid);

    if (!row) return yield* new SourceError({ message: "Invalid Filter policy identity" });

    const entry = yield* refreshEntry(row);
    const now = yield* wallTimestamp;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* applyEntry(sql, client, entry, now, rules, true, graceDays);
      yield* sql`INSERT OR REPLACE INTO state VALUES ('detail_cursor',${row.uuid})`;
    }));
    refreshed++;
  }

  return refreshed;
});

export const refreshLocationEvidence = (sql: SourceSql, client: NavSession, policy: FilterSourcePolicy, rules: IngestRules, graceDays = 0) => Effect.gen(function* () {
  const now = yield* wallTimestamp;
  const snapshot = yield* filterSnapshot(sql, now);
  const rows = yield* decode(Schema.Array(SourceAd), yield* sql`SELECT ads.*, evidence.detail_changed AS evidence_detail_changed FROM ads JOIN versions ON versions.uuid=ads.uuid AND versions.changed=ads.changed LEFT JOIN ad_detail_versions AS evidence ON evidence.uuid=ads.uuid AND evidence.saved_changed=ads.changed WHERE ads.detail_missing=0 AND NOT EXISTS (SELECT 1 FROM ad_locations AS locations WHERE locations.uuid=ads.uuid AND locations.incomplete=0 AND locations.provenance != '') AND (ads.expires IS NULL OR ads.expires > ${now})`);
  const admitted = yield* filterOutput(Schema.Array(LocationCandidate), rows, () => policy.locationCandidates({ ...snapshot, ads: rows }));
  const byId = new Map(rows.map((row) => [row.uuid, row]));
  let current_evidence = 0;
  const pending: (typeof LocationCandidate.Type)[] = [];

  for (const job of admitted) {
    const row = byId.get(job.uuid);

    if (row && row.evidence_detail_changed !== null && row.evidence_detail_changed !== undefined && Either.isRight(timestamp(Predicate.isString(row.evidence_detail_changed) ? row.evidence_detail_changed : null))) current_evidence++;
    else pending.push(job);
  }

  pending.sort((a, b) => codepointOrder(a.uuid, b.uuid));
  const cursor = (yield* sql<{ value: string }>`SELECT value FROM state WHERE key='location_evidence_cursor'`)[0]?.value;
  let attempted = 0;
  let recorded = 0;

  for (const job of rotate(pending, cursor)) {
    if (attempted >= MAX_DETAILS || client.details_remaining <= 0 || client.remaining <= 1 || (yield* monotonicMillis) >= client.deadline) break;

    const row = byId.get(job.uuid);

    if (!row) return yield* new SourceError({ message: "Invalid Filter policy identity" });

    const entry = yield* refreshEntry(row);
    yield* sql.withTransaction(Effect.gen(function* () {
      const applied = yield* applyEntry(sql, client, entry, yield* wallTimestamp, rules, true, graceDays);
      yield* sql`INSERT OR REPLACE INTO state VALUES ('location_evidence_cursor',${row.uuid})`;

      if (applied) {
        const evidence = (yield* sql<{ changed: string; version_changed: string; saved_changed: string; detail_changed: string }>`SELECT ads.changed, versions.changed AS version_changed, evidence.saved_changed, evidence.detail_changed FROM ads JOIN versions ON versions.uuid=ads.uuid JOIN ad_detail_versions AS evidence ON evidence.uuid=ads.uuid WHERE ads.uuid=${row.uuid}`)[0];

        if (evidence && evidence.changed === evidence.version_changed && evidence.changed === evidence.saved_changed && Either.isRight(timestamp(evidence.detail_changed))) recorded++;
      }
    }));
    attempted++;
  }

  return yield* decode(LocationEvidenceRefresh, { candidates: pending.length + current_evidence, current_evidence, eligible: pending.length, attempted, recorded, pending: pending.length - attempted });
});

export const refreshOccupations = (sql: SourceSql, client: NavSession, policy: FilterSourcePolicy, rules: IngestRules, graceDays = 0) => Effect.gen(function* () {
  const snapshot = yield* filterSnapshot(sql, yield* wallTimestamp);
  const jobs = yield* filterOutput(Schema.Array(InsideJob), snapshot.ads, () => policy.insideJobs(snapshot));
  const versions = new Map(snapshot.ads.map((ad) => [ad.uuid, ad.changed]));

  if (jobs.some((job) => versions.get(job.uuid) !== job.source_changed_at)) return yield* new SourceError({ message: "Invalid Filter policy source version" });

  const checks = new Map((yield* sql<{ uuid: string; saved_changed: string }>`SELECT uuid,saved_changed FROM ad_occupation_checks`).map((row) => [row.uuid, row.saved_changed]));
  const pending = jobs.filter((job) => checks.get(job.uuid) !== job.source_changed_at).sort((a, b) => codepointOrder(b.source_changed_at, a.source_changed_at) || codepointOrder(b.uuid, a.uuid));
  const now = yield* wallTimestamp;
  let attempted = 0;
  let stored = 0;
  let closed = 0;

  for (const job of pending) {
    if (client.remaining <= 1 || (yield* monotonicMillis) >= client.deadline) break;

    const [detail] = yield* client.get(ORIGIN + "/api/v1/feedentry/" + job.uuid, "detail");
    attempted++;

    if (detail === null || detail.uuid !== job.uuid) return yield* new SourceError({ message: "NAV detail identity mismatch" });

    if (!Predicate.isString(detail.status) || !statuses.has(detail.status)) return yield* new SourceError({ message: "Unrecognized NAV detail status" });

    const status = detail.status;
    yield* sql.withTransaction(Effect.gen(function* () {
      const changed = status === "ACTIVE" ? job.source_changed_at : yield* timestamp(detail.sistEndret);
      yield* recordSourceStatus(sql, job.uuid, changed, status);

      if (status !== "ACTIVE") {
        yield* closeAdText(sql, job.uuid, now, graceDays);
        yield* sql`DELETE FROM ads WHERE uuid=${job.uuid}`;
        closed++;

        return;
      }

      if (detail.ad_content !== undefined && detail.ad_content !== null && !asObject(detail.ad_content)) return yield* new SourceError({ message: "Malformed NAV ad content" });

      const content = asObject(detail.ad_content) ?? {};

      if (Object.keys(content).length) yield* recordApplicationDue(sql, job.uuid, job.source_changed_at, content);
      yield* replaceOccupations(sql, job.uuid, job.source_changed_at, occupationRecords(content));

      if (Object.keys(content).length) yield* sql`UPDATE ads SET detail_missing=0 WHERE uuid=${job.uuid}`;
      yield* storeDetailText(sql, job.uuid, job.source_changed_at, content, rules.salary);
      stored++;
    }));
  }

  return yield* decode(OccupationRefresh, { inside: jobs.length, pending_before: pending.length, attempted, stored, closed, pending: pending.length - attempted });
});

export const occupationLevelCounts = (sql: SourceSql, policy: FilterSourcePolicy) => Effect.gen(function* () {
  const snapshot = yield* filterSnapshot(sql, yield* wallTimestamp);
  const jobs = yield* filterOutput(Schema.Array(InsideJob), snapshot.ads, () => policy.insideJobs(snapshot));
  const inside = new Set(jobs.map((job) => job.uuid));
  const rows = yield* decode(Schema.Array(Schema.Struct({ uuid: Schema.String, level1: Schema.String })), yield* sql`SELECT uuid,level1 FROM ad_occupations WHERE scheme='occupationCategories' AND level1 != ''`);
  const counts: Record<string, number> = Object.create(null);

  for (const row of rows) {
    if (inside.has(row.uuid)) counts[row.level1] = (counts[row.level1] ?? 0) + 1;
  }

  return counts;
});
