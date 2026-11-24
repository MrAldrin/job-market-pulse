import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer, Schema } from "effect";
import type { FilterSourcePolicy } from "../../src/lib/contracts/source.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { extractSalary } from "../../src/lib/server/market/salary.ts";
import { ORIGIN, type SourceObject } from "../../src/lib/server/source/core.ts";
import { applyEntry, closeAdText, purgeClosedTexts, sync } from "../../src/lib/server/source/ingestion.ts";
import { NavClient, NavClientLive, NavClientReplay, SourceHttp, type NavReplayReply } from "../../src/lib/server/source/nav-client.ts";
import { refreshLocationEvidence, refreshMissing, refreshOccupations } from "../../src/lib/server/source/pipeline.ts";
import { initializeSourceStorage, upgradeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { sourceTopics } from "../../src/lib/server/source/topics.ts";

const directory = process.argv[2]!;
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const pageId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const changed = "2026-10-19T10:00:00+00:00";
const now = "2026-10-19T12:00:00+00:00";
const later = "2026-10-20T10:00:00+00:00";
const detailUrl = ORIGIN + "/api/v1/feedentry/" + id;
const startUrl = ORIGIN + "/api/v1/feed?last";
const pageUrl = ORIGIN + "/api/v1/feed/" + pageId;
const rules = { salary: extractSalary, topics: sourceTopics };
const entry = (event = "e1", status = "ACTIVE", at = changed): SourceObject => ({ id: event, url: detailUrl, _feed_entry: { uuid: id, status, sistEndret: at, title: "Python developer", businessName: "Synthetic AS", municipal: "TEST" } });
const content = (description: string | null = "Lønn kr 650 000 per år. Kontakt ola@example.test"): SourceObject => ({ uuid: id, title: "Python developer", employer: { name: "Synthetic AS" }, updated: changed, expires: "2099-01-01T00:00:00Z", description, source: "SYNTHETIC", workLocations: [{ municipal: "A,B" }], occupationCategories: [{ level1: "IT", level2: " Data " }], applicationDue: " SNAREST\u0085MULIG " });
const detail = (body = content(), at = changed): SourceObject => ({ uuid: id, status: "ACTIVE", sistEndret: at, ad_content: body });
const page = (items: readonly SourceObject[], next?: string): SourceObject => next === undefined ? { id: pageId, items } : { id: pageId, items, next_url: next };
const reply = (url: string, kind: "page" | "detail", body: SourceObject | null): NavReplayReply => ({ url, kind, body });

const program = Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(join(directory, "source.db"), "create");
  yield* initializeSourceStorage(sql);

  const use = (replies: readonly NavReplayReply[], action: (client: import("../../src/lib/server/source/nav-client.ts").NavSession) => Effect.Effect<void, import("../../src/lib/server/source/store.ts").StoreError>) => {
    const replay = NavClientReplay(replies);

    return Effect.gen(function* () {
      const client = yield* (yield* NavClient).session();
      yield* action(client);
      replay.assertConsumed();
    }).pipe(Effect.provide(replay.layer));
  };

  yield* use([reply(startUrl, "page", page([entry()])), reply(detailUrl, "detail", detail())], (client) => Effect.gen(function* () {
    assert.deepEqual(yield* sync(sql, client, rules, { now }), { pages: 1, events: 1, caught_up: true });
  }));
  assert.equal((yield* sql`SELECT text FROM ad_texts`)[0]?.text, "Lønn kr 650 000 per år. Kontakt [e-post]");
  assert.equal((yield* sql`SELECT min_nok FROM ad_salaries`)[0]?.min_nok, 650000);
  assert.equal((yield* sql`SELECT locations FROM ads`)[0]?.locations, '["A,B"]');
  assert.equal((yield* sql`SELECT rolling FROM ad_application_deadlines`)[0]?.rolling, 1);
  assert.deepEqual((yield* sql`SELECT level1,level2 FROM ad_occupations`)[0], { level1: "IT", level2: "Data" });

  // Corrupt final event rolls back the whole new page, its text, event and cursor.
  const broken = entry("bad");
  const invalid = { ...broken, _feed_entry: { uuid: id, status: "BOGUS", sistEndret: later } };
  yield* use([reply(pageUrl, "page", page([entry("e2", "ACTIVE", later), invalid])), reply(detailUrl, "detail", detail(content("Replacement"), later))], (client) => Effect.gen(function* () {
    const failed = yield* Effect.either(sync(sql, client, rules, { now }));
    assert(Either.isLeft(failed));
  }));
  assert.equal((yield* sql`SELECT changed FROM ads`)[0]?.changed, changed);
  assert.equal((yield* sql`SELECT COUNT(*) AS count FROM events`)[0]?.count, 1);
  assert.equal((yield* sql`SELECT text FROM ad_texts`)[0]?.text, "Lønn kr 650 000 per år. Kontakt [e-post]");

  // Duplicate and older closed event cannot replace active evidence or consume detail.
  yield* use([], (client) => Effect.gen(function* () {
    assert.equal(yield* sql.withTransaction(applyEntry(sql, client, entry(), now, rules)), false);
    assert.equal(yield* sql.withTransaction(applyEntry(sql, client, entry("old", "DELETED", "2026-10-18T00:00:00Z"), now, rules)), false);
  }));
  assert.equal((yield* sql`SELECT status FROM ad_status_evidence`)[0]?.status, "ACTIVE");

  // A fetched active detail with no usable description preserves the previous minimized copy.
  yield* use([reply(detailUrl, "detail", detail(content(null), later))], (client) => Effect.gen(function* () {
    yield* sql.withTransaction(applyEntry(sql, client, entry("e3", "ACTIVE", later), now, rules));
  }));
  assert.equal((yield* sql`SELECT detail_changed FROM ad_texts`)[0]?.detail_changed, changed);
  assert.equal((yield* sql`SELECT min_nok FROM ad_salaries`)[0]?.min_nok, 650000);

  const beforeSchema = (yield* sql`PRAGMA schema_version`)[0]?.schema_version;
  const beforeObjects = yield* sql`SELECT * FROM sqlite_master ORDER BY type,name`;
  yield* upgradeSourceStorage(sql);
  assert.equal((yield* sql`PRAGMA schema_version`)[0]?.schema_version, beforeSchema);
  assert.deepEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type,name`, beforeObjects);
  assert.equal((yield* sql`PRAGMA journal_mode`)[0]?.journal_mode, "delete");

  yield* sql.withTransaction(Effect.gen(function* () {
    yield* closeAdText(sql, id, now, 14);
    yield* sql`DELETE FROM ads WHERE uuid=${id}`;
  }));
  assert.equal((yield* sql`SELECT closed_at FROM ad_texts`)[0]?.closed_at, now);
  assert.equal((yield* sql`SELECT COUNT(*) AS count FROM ad_occupations`)[0]?.count, 0);
  assert.equal((yield* sql`SELECT COUNT(*) AS count FROM ad_salaries`)[0]?.count, 1);
  assert.equal(yield* purgeClosedTexts(sql, "2026-11-02T12:00:00+00:00", 14), 1);

  // A malformed next destination is rejected before any page event is applied.
  yield* use([reply(pageUrl, "page", page([entry("not-applied")], "https://attacker.test/api/v1/feed/" + pageId))], (client) => Effect.gen(function* () {
    assert(Either.isLeft(yield* Effect.either(sync(sql, client, rules, { now }))));
  }));
  assert.equal((yield* sql`SELECT COUNT(*) AS count FROM events WHERE id='not-applied'`)[0]?.count, 0);

  // The real client bounds page ingestion at ten detail requests, while applying
  // all events. Later Filter-ranked refreshes complete only the missing evidence.
  const cap = yield* acquireStore(join(directory, "cap.db"), "create");
  yield* initializeSourceStorage(cap);
  const ids = Array.from({ length: 12 }, (_, index) => "00000000-0000-0000-0000-" + (index + 1).toString(16).padStart(12, "0"));
  const capItems = ids.map((uuid, index) => ({ id: "cap-" + index, url: ORIGIN + "/api/v1/feedentry/" + uuid, _feed_entry: { uuid, status: "ACTIVE", sistEndret: changed, title: "Python developer", businessName: "Synthetic AS", municipal: "TEST" } }));

  const capTransport = Layer.succeed(SourceHttp, { request: (url) => {
    const body = url.endsWith("/api/publicToken") ? "eyJsynthetic.payload.signature" : JSON.stringify(url === startUrl ? page(capItems) : { ...detail({ ...content(), uuid: url.split("/").at(-1)! }), uuid: url.split("/").at(-1)! });

    return Effect.succeed({ status: 200, bytes: new TextEncoder().encode(body), headers: {} });
  } });

  yield* Effect.gen(function* () {
    const client = yield* (yield* NavClient).session();
    assert.deepEqual(yield* sync(cap, client, rules, { now }), { pages: 1, events: 12, caught_up: true });
    assert.equal(client.details_remaining, 0);
    assert.equal(client.requests, 12);
  }).pipe(Effect.provide(NavClientLive.pipe(Layer.provide(capTransport))));
  assert.equal((yield* cap`SELECT SUM(detail_missing) AS missing FROM ads`)[0]?.missing, 2);
  assert.equal((yield* cap`SELECT COUNT(*) AS count FROM ad_texts`)[0]?.count, 10);

  const staged: FilterSourcePolicy = {
    rankMissing: (rows) => rows.map((row) => ({ uuid: row.uuid, interest_score: 0 })),
    locationCandidates: (snapshot) => snapshot.ads.map((row) => ({ uuid: row.uuid })),
    insideJobs: (snapshot) => snapshot.ads.map((row) => ({ uuid: row.uuid, source_changed_at: row.changed })),
  };

  const missingReplies = NavClientReplay(ids.slice(10).map((uuid) => reply(ORIGIN + "/api/v1/feedentry/" + uuid, "detail", { ...detail({ ...content(), uuid }), uuid })));
  yield* Effect.gen(function* () {
    const client = yield* (yield* NavClient).session();
    assert.equal(yield* refreshMissing(cap, client, staged, rules), 2);
    missingReplies.assertConsumed();
  }).pipe(Effect.provide(missingReplies.layer));
  assert.equal((yield* cap`SELECT SUM(detail_missing) AS missing FROM ads`)[0]?.missing, 0);
  assert.equal((yield* cap`SELECT value FROM state WHERE key='detail_cursor'`)[0]?.value, ids[11]);
  const target = ids[0]!;
  yield* cap`DELETE FROM ad_detail_versions WHERE uuid=${target}`;
  const evidenceReplies = NavClientReplay([reply(ORIGIN + "/api/v1/feedentry/" + target, "detail", { ...detail({ ...content(), uuid: target }), uuid: target })]);
  yield* Effect.gen(function* () {
    const client = yield* (yield* NavClient).session();
    assert.deepEqual(yield* refreshLocationEvidence(cap, client, staged, rules), { candidates: 12, current_evidence: 11, eligible: 1, attempted: 1, recorded: 1, pending: 0 });
    evidenceReplies.assertConsumed();
  }).pipe(Effect.provide(evidenceReplies.layer));
  assert.equal((yield* cap`SELECT value FROM state WHERE key='location_evidence_cursor'`)[0]?.value, target);
  yield* cap`DELETE FROM ad_occupation_checks WHERE uuid=${target}`;
  const closure = NavClientReplay([reply(ORIGIN + "/api/v1/feedentry/" + target, "detail", { uuid: target, status: "INACTIVE", sistEndret: later })]);
  yield* Effect.gen(function* () {
    const client = yield* (yield* NavClient).session();
    assert.deepEqual(yield* refreshOccupations(cap, client, staged, rules), { inside: 12, pending_before: 1, attempted: 1, stored: 0, closed: 1, pending: 0 });
    closure.assertConsumed();
  }).pipe(Effect.provide(closure.layer));
  assert.equal((yield* cap`SELECT COUNT(*) AS count FROM ads WHERE uuid=${target}`)[0]?.count, 0);
  assert.equal((yield* cap`SELECT COUNT(*) AS count FROM ad_texts WHERE uuid=${target}`)[0]?.count, 0);
  assert.equal((yield* cap`SELECT COUNT(*) AS count FROM ad_salaries WHERE uuid=${target}`)[0]?.count, 1);
  assert.equal((yield* cap`SELECT status FROM ad_status_evidence WHERE uuid=${target}`)[0]?.status, "INACTIVE");

  const legacy = yield* acquireStore(join(directory, "legacy.db"), "create");
  yield* legacy.unsafe((yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE name='ads'`)[0]!.sql);
  yield* legacy`CREATE TABLE ad_texts(uuid TEXT PRIMARY KEY,text TEXT NOT NULL,detail_changed TEXT NOT NULL)`;
  yield* legacy`INSERT INTO ad_texts VALUES (${id},'old minimized copy',${changed})`;
  yield* legacy`CREATE TABLE ad_application_deadlines(uuid TEXT PRIMARY KEY,changed TEXT NOT NULL,application_due TEXT)`;
  yield* legacy`INSERT INTO ad_application_deadlines VALUES (${id},${changed},'Snarest mulig')`;
  yield* legacy`CREATE TABLE ad_salaries(uuid TEXT PRIMARY KEY,form TEXT CHECK(form IN ('single','range','vague')),min_nok REAL,max_nok REAL,period TEXT,sko_code TEXT,ltr_min INTEGER,ltr_max INTEGER,detail_changed TEXT NOT NULL)`;
  yield* legacy`INSERT INTO ad_salaries VALUES (${id},'single',650000,650000,'year',NULL,NULL,NULL,${changed})`;
  yield* upgradeSourceStorage(legacy);
  assert.equal((yield* legacy`SELECT text,closed_at FROM ad_texts`)[0]?.text, "old minimized copy");
  assert.deepEqual((yield* legacy`SELECT application_due,rolling FROM ad_application_deadlines`)[0], { application_due: null, rolling: 1 });
  assert.equal((yield* legacy`SELECT amount_unclear FROM ad_salaries`)[0]?.amount_unclear, 0);
  yield* legacy`UPDATE ad_salaries SET form='max'`;
  const wrong = yield* acquireStore(join(directory, "wrong.db"), "create");
  yield* wrong`CREATE TABLE unrelated(secret TEXT)`;
  assert(Either.isLeft(yield* Effect.either(upgradeSourceStorage(wrong))));
  assert.equal((yield* wrong`SELECT COUNT(*) AS count FROM sqlite_master WHERE name='ads'`)[0]?.count, 0);

  assert(Schema.is(Schema.String)(directory));
  console.log("ingestion: passed");
}));

await Effect.runPromise(program.pipe(Effect.provide(BunContext.layer)));
