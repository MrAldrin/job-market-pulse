import { Clock, Effect, Predicate } from "effect";
import type { SourceAd } from "../../contracts/source-readers.ts";
import type { CollectionOptions } from "../../contracts/source.ts";
import type { SalaryFacts } from "../../contracts/salary.ts";
import { type JsonInput } from "../shared/json-input.ts";
import { pythonJson } from "../shared/python-json.ts";
import { apiUrl, asObject, isRollingDeadline, locationLabels, occupationRecords, ORIGIN, statuses, text, timestamp, truthy, utcText, uuid, type SourceObject } from "./core.ts";
import { SourceError } from "./errors.ts";
import type { NavSession } from "./nav-client.ts";
import { scrubContactDetails } from "./scrub.ts";
import type { SourceSql } from "./store.ts";

export type SalaryExtractor = (description: string) => SalaryFacts;

export type TopicExtractor = (searchable: string) => readonly string[];

export interface IngestRules { readonly salary: SalaryExtractor; readonly topics: TopicExtractor }

export const wallMicros = Clock.currentTimeMillis.pipe(Effect.map((millis) => BigInt(Math.trunc(millis)) * 1000n));
export const wallTimestamp = wallMicros.pipe(Effect.map((micros) => utcText(micros)));
const graceEnd = "2026-11-11T00:00:00+00:00";
export const effectiveGrace = (configured: number, now: string): number => now >= graceEnd ? 0 : configured;

export const closeAdText = (sql: SourceSql, id: string, now: string, grace: number) => effectiveGrace(grace, now) > 0
  ? sql`UPDATE ad_texts SET closed_at=${now.slice(0, 19) + "+00:00"} WHERE uuid=${id} AND closed_at IS NULL`
  : sql`DELETE FROM ad_texts WHERE uuid=${id}`;

export const purgeClosedTexts = (sql: SourceSql, now: string, grace: number) => Effect.gen(function* () {
  const days = effectiveGrace(grace, now);

  if (days === 0) yield* sql`DELETE FROM ad_texts WHERE closed_at IS NOT NULL AND uuid NOT IN (SELECT uuid FROM ads)`;
  else {
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString().slice(0, 19) + "+00:00";
    yield* sql`DELETE FROM ad_texts WHERE closed_at IS NOT NULL AND uuid NOT IN (SELECT uuid FROM ads) AND closed_at <= ${cutoff}`;
  }

  const rows = yield* sql<{ count: number }>`SELECT changes() AS count`;

  return rows[0]?.count ?? 0;
});

export const replaceOccupations = (sql: SourceSql, id: string, changed: string, records: readonly (readonly string[])[]) => Effect.gen(function* () {
  yield* sql`DELETE FROM ad_occupations WHERE uuid=${id}`;

  for (const record of records) yield* sql`INSERT INTO ad_occupations VALUES (${id},${record[0] ?? ""},${record[1] ?? ""},${record[2] ?? ""},${record[3] ?? ""},${record[4] ?? ""})`;

  yield* sql`INSERT OR REPLACE INTO ad_occupation_checks VALUES (${id},${changed},${records.length})`;
});

export const recordApplicationDue = (sql: SourceSql, id: string, changed: string, content: SourceObject) => Effect.gen(function* () {
  if (!Object.hasOwn(content, "applicationDue")) {
    yield* sql`DELETE FROM ad_application_deadlines WHERE uuid=${id} AND changed<=${changed}`;

    return;
  }

  let value = content.applicationDue ?? null;
  let rolling = 0;

  if (value !== null && (!Predicate.isString(value) || Array.from(value).length > 256)) value = null;
  else if (Predicate.isString(value) && isRollingDeadline(value)) { value = null; rolling = 1; }

  const due = Predicate.isString(value) ? value : null;
  yield* sql`INSERT INTO ad_application_deadlines(uuid,changed,application_due,rolling) VALUES (${id},${changed},${due},${rolling}) ON CONFLICT(uuid) DO UPDATE SET changed=excluded.changed,application_due=excluded.application_due,rolling=excluded.rolling WHERE excluded.changed >= ad_application_deadlines.changed`;
});

export const recordSourceStatus = (sql: SourceSql, id: string, changed: string, status: string) =>
  sql`INSERT INTO ad_status_evidence(uuid,changed,status) VALUES (${id},${changed},${status}) ON CONFLICT(uuid) DO UPDATE SET changed=excluded.changed,status=excluded.status WHERE excluded.changed >= ad_status_evidence.changed`;

export const storeDetailText = (sql: SourceSql, id: string, changed: string, content: SourceObject, extract: SalaryExtractor) => Effect.gen(function* () {
  const original = content.description;

  if (!Predicate.isString(original)) return;

  const description = scrubContactDetails(original);

  if (!description) return;

  yield* sql`DELETE FROM ad_texts WHERE uuid=${id}`;
  yield* sql`INSERT INTO ad_texts (uuid,text,detail_changed) VALUES (${id},${description},${changed})`;
  const facts = extract(original);
  yield* sql`DELETE FROM ad_salaries WHERE uuid=${id}`;

  if (facts.form !== null || facts.sko_code !== null || facts.ltr_min !== null || facts.amount_unclear) {
    yield* sql`INSERT INTO ad_salaries (uuid,form,min_nok,max_nok,period,sko_code,ltr_min,ltr_max,detail_changed,period_inferred,amount_unclear) VALUES (${id},${facts.form},${facts.min_nok},${facts.max_nok},${facts.period},${facts.sko_code},${facts.ltr_min},${facts.ltr_max},${changed},${Number(facts.period_inferred)},${Number(facts.amount_unclear)})`;
  }
});

// Caller supplies the transaction: one whole page, or one explicit detail refresh.
export const applyEntry = (sql: SourceSql, client: NavSession, input: JsonInput, now: string, rules: IngestRules, refresh = false, grace = 0) => Effect.gen(function* () {
  const item = asObject(input);
  const entry = asObject(item?._feed_entry);

  if (!item || !entry) return yield* new SourceError({ message: "Malformed NAV feed entry" });

  const event = item.id;
  const id = entry.uuid;
  let status = entry.status;

  if (!Predicate.isString(event) || !Predicate.isString(id)) return yield* new SourceError({ message: "Missing NAV event/ad identifier" });

  if (!Predicate.isString(status) || !statuses.has(status)) return yield* new SourceError({ message: "Unrecognized NAV status" });

  if (!refresh && (yield* sql`SELECT 1 FROM events WHERE id=${event}`).length) return false;

  let changed = yield* timestamp(entry.sistEndret);
  const previous = (yield* sql<SourceAd>`SELECT * FROM ads WHERE uuid=${id}`)[0];
  const version = (yield* sql<{ changed: string }>`SELECT changed FROM versions WHERE uuid=${id}`)[0];

  if (version && version.changed > changed) {
    yield* sql`INSERT INTO events VALUES (${event})`;

    return false;
  }

  let content: SourceObject = {};
  let detailChanged: string | null = null;

  if (status === "ACTIVE" && client.details_remaining > 0 && client.remaining > 1) {
    client.details_remaining--;
    const [detail] = yield* client.get(text(item.url), "detail");

    if (detail === null || detail.uuid !== id) return yield* new SourceError({ message: "NAV detail identity mismatch" });

    if (!Predicate.isString(detail.status) || !statuses.has(detail.status)) return yield* new SourceError({ message: "Unrecognized NAV detail status" });

    detailChanged = yield* timestamp(detail.sistEndret);
    changed = changed > detailChanged ? changed : detailChanged;
    status = detail.status;

    if (detail.ad_content !== undefined && detail.ad_content !== null && !asObject(detail.ad_content)) return yield* new SourceError({ message: "Malformed NAV ad content" });

    content = asObject(detail.ad_content) ?? {};
  }

  if (status !== "ACTIVE") {
    yield* closeAdText(sql, id, now, grace);
    yield* sql`DELETE FROM ads WHERE uuid=${id}`;
    yield* sql`DELETE FROM ad_detail_versions WHERE uuid=${id}`;
  } else {
    yield* sql`DELETE FROM ad_texts WHERE uuid=${id} AND closed_at IS NOT NULL`;
    yield* sql`DELETE FROM ad_detail_versions WHERE uuid=${id}`;
    yield* sql`DELETE FROM ad_locations WHERE uuid=${id}`;
    const title = text(content.title) || text(entry.title);
    const employer = text(asObject(content.employer)?.name) || text(entry.businessName);
    const locations = truthy(content.workLocations) ? content.workLocations : [];

    if (!Array.isArray(locations)) return yield* new SourceError({ message: "Malformed NAV work locations" });

    let places = locationLabels(locations);

    if (!places.length && text(entry.municipal)) places = [text(entry.municipal)];

    const topics = rules.topics(title + " " + text(content.description));
    const expires = truthy(content.expires) ? yield* timestamp(content.expires) : null;
    const missing = Number(Object.keys(content).length === 0);
    // Source string columns use json.dumps defaults (spaces after separators).
    const placesJson = "[" + places.map((place) => pythonJson(place)).join(", ") + "]";
    const topicsJson = "[" + topics.map((topic) => pythonJson(topic)).join(", ") + "]";
    yield* sql`INSERT INTO ads VALUES (${id},${changed},${previous?.first_seen ?? now},${now},${title},${employer},${placesJson},${topicsJson},${missing},${expires},${text(content.source)}) ON CONFLICT(uuid) DO UPDATE SET changed=excluded.changed,observed=excluded.observed,title=excluded.title,employer=excluded.employer,locations=excluded.locations,topics=excluded.topics,detail_missing=excluded.detail_missing,expires=excluded.expires,source=excluded.source`;

    if (detailChanged !== null) {
      yield* sql`INSERT OR REPLACE INTO ad_detail_versions VALUES (${id},${changed},${detailChanged})`;
      yield* storeDetailText(sql, id, changed, content, rules.salary);
    } else yield* sql`DELETE FROM ad_texts WHERE uuid=${id}`;

    if (Object.keys(content).length) {
      yield* recordApplicationDue(sql, id, changed, content);
      yield* replaceOccupations(sql, id, changed, occupationRecords(content));
    } else {
      yield* sql`DELETE FROM ad_occupations WHERE uuid=${id}`;
      yield* sql`DELETE FROM ad_occupation_checks WHERE uuid=${id}`;
    }
  }

  yield* sql`INSERT OR REPLACE INTO versions VALUES (${id},${changed})`;
  yield* recordSourceStatus(sql, id, changed, status);

  if (!refresh) yield* sql`INSERT INTO events VALUES (${event})`;

  return true;
});

export const sync = (sql: SourceSql, client: NavSession, rules: IngestRules, options: CollectionOptions = {}) => Effect.gen(function* () {
  const now = yield* timestamp(options.now ?? (yield* wallTimestamp));
  const saved = (yield* sql<{ value: string }>`SELECT value FROM state WHERE key='cursor'`)[0];

  if (options.since && saved) return yield* new SourceError({ message: "Dated collection requires a fresh database; keep the existing cursor" });

  const start = options.since ? yield* timestamp(options.since) : null;
  let url = saved?.value ?? ORIGIN + (start ? "/api/v1/feed" : "/api/v1/feed?last");
  let pages = 0;
  let events = 0;
  let caught_up = false;
  const grace = options.graceDays ?? 0;

  for (let index = 0; index < (options.maxPages ?? 5); index++) {
    if (client.remaining < (client.token === null ? 2 : 1)) break;

    url = yield* apiUrl(url, "page");
    const cached = (yield* sql<{ etag: string | null; modified: string | null }>`SELECT * FROM pages WHERE url=${url}`)[0];
    const conditional: Record<string, string> = {};

    if (start && pages === 0) conditional["If-Modified-Since"] = new Date(start).toUTCString();

    if (cached?.etag) conditional["If-None-Match"] = cached.etag;

    if (cached?.modified) conditional["If-Modified-Since"] = cached.modified;

    const [page, headers] = yield* client.get(url, "page", conditional);

    if (page === null) { caught_up = true; break; }

    if (!Array.isArray(page.items)) return yield* new SourceError({ message: "Malformed NAV page" });

    if (!Predicate.isString(page.id)) return yield* new SourceError({ message: "Malformed NAV page identifier" });

    const pageId = yield* uuid(page.id).pipe(Effect.mapError(() => new SourceError({ message: "Malformed NAV page identifier" })));
    const current = ORIGIN + "/api/v1/feed/" + pageId;
    const next = page.next_url ?? null;

    if (next !== null && !Predicate.isString(next)) return yield* new SourceError({ message: "Malformed NAV next-page URL" });

    const target = next ? yield* apiUrl(next, "page") : current;

    if (next && target === current) return yield* new SourceError({ message: "NAV pagination loop" });

    const items = page.items;

    const count = yield* sql.withTransaction(Effect.gen(function* () {
      let count = 0;

      for (const item of items) count += Number(yield* applyEntry(sql, client, item, now, rules, false, grace));

      const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      yield* sql`INSERT OR REPLACE INTO pages VALUES (${current},${lower.etag ?? null},${lower["last-modified"] ?? null})`;
      yield* sql`INSERT OR REPLACE INTO state VALUES ('cursor',${target})`;

      if (start) yield* sql`INSERT OR REPLACE INTO state VALUES ('collection_start',${start})`;

      return count;
    }));

    events += count;
    pages++;
    url = target;

    if (!next) { caught_up = true; break; }
  }

  yield* sql.withTransaction(Effect.gen(function* () {
    const expired = yield* sql<{ uuid: string }>`SELECT uuid FROM ads WHERE expires IS NOT NULL AND expires <= ${now}`;

    for (const ad of expired) yield* closeAdText(sql, ad.uuid, now, grace);

    yield* sql`DELETE FROM ads WHERE expires IS NOT NULL AND expires <= ${now}`;
    yield* purgeClosedTexts(sql, now, grace);
    yield* sql`INSERT OR REPLACE INTO state VALUES ('checked',${now})`;
    yield* sql`INSERT OR REPLACE INTO state VALUES ('caught_up',${String(Number(caught_up))})`;
  }));

  return { pages, events, caught_up };
});
