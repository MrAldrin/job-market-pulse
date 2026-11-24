import { Effect, Schema } from "effect";
import { MarketSourceAd, SourceSalaryRow } from "../../contracts/source-market.ts";
import { timestamp } from "./core.ts";
import type { JsonInput } from "../shared/json-input.ts";
import { SourceError } from "./errors.ts";
import { readManifestSnapshot } from "./readers.ts";
import { acquireStore, hasTable, readSnapshot, type SourceSql } from "./store.ts";

const decode = <A, I>(schema: Schema.Schema<A, I>, value: JsonInput) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => new SourceError({ message: "Invalid Market source data" })));

// Exact retained Market six-column selection and expiry/order policy.
export const readMarketSource = (sql: SourceSql, now: string) => Effect.gen(function* () {
  const instant = yield* timestamp(now);

  return yield* decode(Schema.Array(MarketSourceAd), yield* sql<MarketSourceAd>`SELECT uuid, first_seen, title, employer, locations, topics FROM ads WHERE expires IS NULL OR expires > ${instant} ORDER BY uuid`);
});

// Legacy optional columns remain absent; this reader never initializes or upgrades.
export const readSalarySource = (sql: SourceSql) => Effect.gen(function* () {
  const textRows = (yield* hasTable(sql, "ad_texts")) ? yield* decode(Schema.Array(Schema.Struct({ uuid: Schema.String, detail_changed: Schema.String })), yield* sql<{ uuid: string; detail_changed: string }>`SELECT uuid,detail_changed FROM ad_texts`) : [];
  const text_versions = Object.fromEntries(textRows.map((row) => [row.uuid, row.detail_changed]));

  if (!(yield* hasTable(sql, "ad_salaries"))) return { salaries: [], text_versions };
  const columns = new Set((yield* sql<{ name: string }>`PRAGMA table_info(ad_salaries)`).map((column) => column.name));
  const hasAds = yield* hasTable(sql, "ads");
  const ltrMax = columns.has("ltr_max") ? "s.ltr_max" : "NULL AS ltr_max";
  const inferred = columns.has("period_inferred") ? "s.period_inferred" : "0 AS period_inferred";
  const unclear = columns.has("amount_unclear") ? "s.amount_unclear" : "0 AS amount_unclear";
  const identity = hasAds ? "a.title,a.employer,(a.uuid IS NULL) AS closed" : "NULL AS title,NULL AS employer,0 AS closed";
  const rows = yield* sql.unsafe<Record<string, string | number | null>>(`SELECT s.uuid,${identity},s.form,s.min_nok,s.max_nok,s.period,s.sko_code,s.ltr_min,${ltrMax},s.detail_changed,${inferred},${unclear} FROM ad_salaries s${hasAds ? " LEFT JOIN ads a ON a.uuid=s.uuid" : ""}`);
  const salaries = yield* decode(Schema.Array(SourceSalaryRow), rows.map((row) => ({ ...row, period_inferred: Boolean(row.period_inferred), amount_unclear: Boolean(row.amount_unclear), closed: Boolean(row.closed) })));

  return { salaries, text_versions };
});

export const readMarketCapture = (path: string, now: string) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "readonly");

  return yield* readSnapshot(sql, Effect.gen(function* () {
    const ads = yield* readMarketSource(sql, now);
    const manifest = yield* readManifestSnapshot(sql, 100_000, now);

    return { ads, manifest, occupations: manifest.occupation_pairs };
  }));
}));

export type MarketSourceCapture = Effect.Effect.Success<ReturnType<typeof readMarketCapture>>;

export const readSalaryFacts = (path: string) => Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "readonly");

  return yield* readSnapshot(sql, readSalarySource(sql));
}));
