import { Reactivity } from "@effect/experimental";
import { acquireSqliteResource } from "../../src/lib/server/shared/sqlite-resource.ts";
import { Database } from "bun:sqlite";
import { Deferred, Effect, Either, Fiber, Layer, Predicate, Schema, TestClock, TestContext } from "effect";
import fc from "fast-check";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { AddressClient, AddressClientLive, matchesDetail, resolveCandidates, type AddressSession } from "../../src/lib/server/source/locations.ts";
import { monotonicMillis, NavClient, NavClientLive, SourceHttp, type NavSession, type WireResponse } from "../../src/lib/server/source/nav-client.ts";
import { ResolutionError, SourceError } from "../../src/lib/server/source/errors.ts";
import { asObject, type SourceObject } from "../../src/lib/server/source/core.ts";
import { readSnapshot, withReservedConnection, type SourceSql } from "../../src/lib/server/source/store.ts";
import { AddressResolution, ResolutionInput, ResolutionResult } from "../../src/lib/contracts/source-locations.ts";

const id = "00000000-0000-0000-0000-000000000001";
const other = "00000000-0000-0000-0000-000000000002";
const changed = "2026-01-01T00:00:00+00:00";
const later = "2026-01-02T00:00:00+00:00";
const workplace = { municipal: "Oslo", country: "NORGE", address: "Street 1", postalCode: "1234" };
const detail = (uuid = id): SourceObject => ({ uuid, status: "ACTIVE", sistEndret: changed, ad_content: { uuid, updated: changed, title: "Role", employer: { name: "Firm" }, workLocations: [{ ...workplace }] } });

const content = (value: SourceObject): SourceObject => {
  const result = asObject(value.ad_content);
  assert.ok(result);

  return result;
};

const row = { uuid: id, title: "Role", employer: "Firm", locations: '["Oslo"]', expires: null };
const candidates = [{ uuid: id }];
const match = (flag: boolean | null = true) => ({ metadata: { totaltAntallTreff: 1 }, adresser: [{ adressetekst: "Street 1", postnummer: "1234", stedfestingverifisert: flag, representasjonspunkt: { epsg: "EPSG:4326", lat: 61.2, lon: 11.3 } }] });
const wire = (body: import("../../src/lib/server/shared/json-input.ts").JsonInput, status = 200): WireResponse => ({ status, bytes: new TextEncoder().encode(Predicate.isString(body) ? body : JSON.stringify(body)), headers: {} });
const addressLayer = (request: SourceHttp["Type"]["request"]) => AddressClientLive.pipe(Layer.provide(Layer.succeed(SourceHttp, { request })));

const addressSession = (reply = match()) => Effect.gen(function* () {
  return yield* (yield* AddressClient).session();
}).pipe(Effect.provide(addressLayer(() => Effect.succeed(wire(reply)))));

const navSession = (get: (uuid: string) => Effect.Effect<SourceObject | null, SourceError> = (uuid) => Effect.succeed(detail(uuid))): Effect.Effect<NavSession> => Effect.gen(function* () {
  const nav: NavSession = { requests: 0, remaining: 10, details_remaining: 10, token: "synthetic", deadline: (yield* monotonicMillis) + 90_000,
    get: (url) => Effect.gen(function* () { nav.requests++;

 return [yield* get(url.split("/").at(-1)!), {}] as const; }),
  };

  return nav;
});

const resolve = (sql: SourceSql, nav: NavSession, address: AddressSession, options: Parameters<typeof resolveCandidates>[5] = {}) => resolveCandidates(sql, nav, address, candidates, 1, { now: changed, ...options });

const storeCase = async (program: (sql: SourceSql, second: Database, path: string) => Effect.Effect<void, unknown>) => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-location-"));
  const path = join(dir, "source.db");
  const second = new Database(path, { create: true });

  try {
    // The fixture checks transaction isolation, not power-loss durability.
    second.exec("PRAGMA synchronous=OFF");
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* acquireSqliteResource({ filename: path });
      yield* sql`PRAGMA synchronous=OFF`;
      yield* initializeSourceStorage(sql);

      for (const uuid of [id, other]) {
        yield* sql`INSERT INTO ads VALUES (${uuid}, ${changed}, ${changed}, ${changed}, ${"Role"}, ${"Firm"}, ${'["Oslo"]'}, ${"[]"}, ${0}, ${null}, ${"NAV"})`;
        yield* sql`INSERT INTO versions VALUES (${uuid}, ${changed})`;
      }

      yield* program(sql, second, path);
    })).pipe(Effect.provide(Reactivity.layer), Effect.provide(TestContext.TestContext)));
  } finally { second.close(); await rm(dir, { recursive: true, force: true }); }
};

const run = (program: Effect.Effect<void, unknown, never>) => Effect.runPromise(program);

export const detailCase = () => {
  assert.equal(matchesDetail(detail(), row, changed, changed)?.length, 1);

  for (const value of ["STOPPED", "active", "", null, 1n]) assert.equal(matchesDetail({ ...detail(), status: value }, row, changed, changed), null);

  for (const field of ["uuid", "title", "updated", "employer", "workLocations"]) {
    const value = detail();
    assert.equal(matchesDetail({ ...value, ad_content: { ...content(value), [field]: null } }, row, changed, changed), null);
  }

  fc.assert(fc.property(fc.string().filter((title) => title !== "Role"), (title) => {
    const value = detail();
    assert.equal(matchesDetail({ ...value, ad_content: { ...content(value), title } }, row, changed, changed), null);
  }));
  const value = detail();
  const valid = (fields: SourceObject, saved: SourceObject = row) => matchesDetail({ ...value, ad_content: { ...content(value), ...fields } }, saved, changed, changed);
  assert.equal(valid({ updated: "2025-01-01T00:00:00.123456Z" })?.length, 1);
  assert.equal(valid({ workLocations: Array.from({ length: 100 }, () => workplace) })?.length, 100);
  assert.equal(valid({ workLocations: Array.from({ length: 101 }, () => workplace) }), null);
  assert.equal(valid({ workLocations: [workplace, null] }), null);
  assert.equal(valid({ workLocations: [{ municipal: "" , city: "Oslo" }, { municipal: "Oslo" }] })?.length, 2);
  assert.equal(valid({ workLocations: [{ municipal: " Oslo" }] }), null); // Labels are not normalized.
  const labels = ["\u{10000}", "\ue000"];
  assert.equal(valid({ workLocations: labels.map((municipal) => ({ municipal })) }, { ...row, locations: JSON.stringify(labels) })?.length, 2);
  assert.equal(valid({}, { ...row, locations: '["Oslo","Oslo"]' }), null);
  assert.equal(valid({ expires: changed }, { ...row, expires: changed }), null);
  assert.equal(valid({ expires: later }, { ...row, expires: later })?.length, 1);
  assert.equal(valid({ expires: "bad" }), null);
  const earlier = { ...detail(), sistEndret: "2025-12-31T23:59:00Z" };
  assert.equal(matchesDetail(earlier, row, changed, changed), null);
  assert.equal(matchesDetail(earlier, row, changed, changed, 60_000_000n)?.length, 1);
  assert.equal(matchesDetail(earlier, row, changed, changed, 59_999_999n), null);
  assert.equal(matchesDetail({ ...detail(), sistEndret: later }, row, changed, changed, 100_000_000_000n), null);
};

const replies: WireResponse[] = [];
const calls: { url: string; maximum: number; timeout: number }[] = [];

export const addressCase = () => run(Effect.gen(function* () {
  const client = yield* AddressClient;

  for (const flag of [true, false, null]) {
    replies.push(wire(match(flag)));
    const session = yield* client.session();
    const found = yield* session.resolve("  STREET  1 ", "1234");
    assert.deepEqual(found, { coordinates: [61.2, 11.3], provider_stedfestingverifisert: flag });
    assert.equal(session.coordinate_verification_counts[flag === null ? "not_reported" : flag ? "provider_true" : "provider_false"], 1);
  }

  const missing: { metadata: { totaltAntallTreff: number }; adresser: { stedfestingverifisert?: boolean | null }[] } = match();
  delete missing.adresser[0]!.stedfestingverifisert;
  replies.push(wire(missing));
  assert.equal((yield* (yield* client.session()).resolve("Street 1", "1234"))?.provider_stedfestingverifisert, null);

  // Native JSON __proto__ is data, not inherited match-count/address evidence.
  const rawMatch = JSON.stringify(match());
  replies.push(wire(rawMatch.replace('"metadata":{"totaltAntallTreff":1}', '"metadata":{"__proto__":{"totaltAntallTreff":1}}')));
  const inheritedCount = yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"));
  assert.ok(Either.isLeft(inheritedCount) && inheritedCount.left instanceof ResolutionError);
  assert.equal(inheritedCount.left.message, "Invalid official address match count");

  for (const [replacement, reason] of [
    ['"representasjonspunkt":{"__proto__":{"epsg":"EPSG:4326","lat":61.2,"lon":11.3}}', "unsupported_coordinate_system"],
    ['"representasjonspunkt":{"epsg":"EPSG:4326","__proto__":{"lat":61.2,"lon":11.3}}', "invalid_coordinates"],
  ] as const) {
    replies.push(wire(rawMatch.replace('"representasjonspunkt":{"epsg":"EPSG:4326","lat":61.2,"lon":11.3}', replacement)));
    const own = yield* client.session();
    assert.equal(yield* own.resolve("Street 1", "1234"), null);
    assert.equal(own.rejections[reason], 1);
  }

  replies.push(wire(rawMatch.replace('"totaltAntallTreff":1', '"totaltAntallTreff":1,"__proto__":{"unused":true}')));
  assert.ok(yield* (yield* client.session()).resolve("Street 1", "1234"));

  for (const count of ["true", "1.0", "1e0", "null", '"1"']) {
    replies.push(wire(JSON.stringify(match()).replace('"totaltAntallTreff":1', '"totaltAntallTreff":' + count)));
    const result = yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(result) && result.left instanceof ResolutionError);
  }

  const rejects: readonly [keyof AddressSession["rejections"], (data: ReturnType<typeof match>) => void][] = [
    ["no_unique_match", (data) => { data.metadata.totaltAntallTreff = 2; }],
    ["no_unique_match", (data) => { data.adresser.push(data.adresser[0]!); }],
    ["address_mismatch", (data) => { data.adresser[0]!.adressetekst = "Street 2"; }],
    ["postcode_mismatch", (data) => { data.adresser[0]!.postnummer = "0123"; }],
    ["unsupported_coordinate_system", (data) => { data.adresser[0]!.representasjonspunkt.epsg = "4326.0"; }],
    ["invalid_coordinates", (data) => { data.adresser[0]!.representasjonspunkt.lat = 91; }],
    ["invalid_verification_flag", (data) => { Object.assign(data.adresser[0]!, { stedfestingverifisert: 1 }); }],
    ["invalid_coordinates", (data) => { Object.assign(data.adresser[0]!.representasjonspunkt, { lat: true }); }],
  ];

  for (const [reason, alter] of rejects) {
    const data = match(); alter(data); replies.push(wire(data));
    const session = yield* client.session();
    assert.equal(yield* session.resolve("Street 1", "1234"), null);
    assert.equal(session.rejections[reason], 1);
  }

  for (const epsg of [4326, "4326", "EPSG:4326"]) {
    const data = match(); Object.assign(data.adresser[0]!.representasjonspunkt, { epsg }); replies.push(wire(data));
    assert.ok(yield* (yield* client.session()).resolve("Street 1", "1234"));
  }

  replies.push(wire(JSON.stringify(match()).replace('"epsg":"EPSG:4326"', '"epsg":4326.0')));
  assert.equal(yield* (yield* client.session()).resolve("Street 1", "1234"), null);
  const session = yield* client.session();

  for (const [a, p] of [["Region", "1234"], ["Street 1", "12"], ["Street\n1", "1234"], ["Street 1", "１２３４"], [true, "1234"], ["x".repeat(300) + "1", "1234"]] as const) assert.equal(yield* session.resolve(a, p), null);
  assert.equal(session.requests, 0);
  const unicode = "😀".repeat(299) + "1";
  const data = match(); data.adresser[0]!.adressetekst = unicode; replies.push(wire(data));
  assert.ok(yield* (yield* client.session()).resolve(unicode, "1234"));

  for (const literal of ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"]) {
    replies.push(wire(JSON.stringify(match()).replace('"lat":61.2', '"lat":' + literal)));
    const nonfinite = yield* client.session();
    assert.equal(yield* nonfinite.resolve("Street 1", "1234"), null);
    assert.equal(nonfinite.rejections.invalid_coordinates, 1);
  }

  replies.push(wire(JSON.stringify(match()).replace('"stedfestingverifisert":true', '"stedfestingverifisert":NaN')));
  const nonfiniteFlag = yield* client.session();
  assert.equal(yield* nonfiniteFlag.resolve("Street 1", "1234"), null);
  assert.equal(nonfiniteFlag.rejections.invalid_verification_flag, 1);

  for (const literal of ["NaN", "Infinity", "-Infinity"]) {
    replies.push(wire(JSON.stringify(match()).replace('"totaltAntallTreff":1', '"totaltAntallTreff":' + literal)));
    const invalidCount = yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(invalidCount) && invalidCount.left instanceof ResolutionError);
    assert.equal(invalidCount.left.message, "Invalid official address match count");
  }

  for (const text of ['Street "NaN" Infinity 1', 'Street \\ "-Infinity" 1']) {
    const quoted = match(); quoted.adresser[0]!.adressetekst = text;
    replies.push(wire(quoted));
    assert.ok(yield* (yield* client.session()).resolve(text, "1234"));
  }

  for (const literal of ["NaNthing", "+Infinity", "-NaN", "Infinityx"]) {
    replies.push(wire(JSON.stringify(match()).replace('"lat":61.2', '"lat":' + literal)));
    const malformed = yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(malformed) && malformed.left instanceof ResolutionError);
    assert.equal(malformed.left.message, "Official address lookup failed");
  }

  for (const response of [wire("bad"), wire([]), wire({}), { ...wire(""), bytes: new Uint8Array([0xff]) }, wire("x".repeat(65_537))]) {
    replies.push(response);
    assert.ok(Either.isLeft(yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"))));
  }

  const exact = JSON.stringify(match()); replies.push(wire(exact + " ".repeat(65_536 - exact.length)));
  assert.ok(yield* (yield* client.session()).resolve("Street 1", "1234"));

  for (const status of [302, 400, 404, 429, 500, 503]) {
    replies.push(wire({}, status));
    const failure = yield* Effect.either((yield* client.session()).resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(failure));
    assert.equal(failure.left instanceof SourceError && failure.left.transient === true, status >= 429);
  }

  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://ws.geonorge.no/adresser/v1/sok");
    assert.equal(url.searchParams.get("fuzzy"), "false"); assert.equal(url.searchParams.get("utkoordsys"), "4326");
    assert.equal(url.searchParams.get("treffPerSide"), "2"); assert.equal(call.maximum, 65_536); assert.ok(call.timeout <= 10_000);
  }

  assert.equal(replies.length, 0);
}).pipe(Effect.provide(addressLayer((url, _headers, maximum, timeout) => Effect.sync(() => {
  calls.push({ url, maximum, timeout });
  const reply = replies.shift();
  assert.ok(reply);

  return reply;
})))));

export const clockCase = async () => {
  const times: number[] = [];
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* AddressClient;
    const session = yield* client.session();
    assert.equal(session.deadline, (yield* monotonicMillis) + 90_000);
    yield* session.resolve("Street 1", "1234");
    const second = yield* Effect.fork(session.resolve("Street 1", "1234"));
    yield* TestClock.adjust(999);
    assert.equal(times.length, 1);
    yield* TestClock.adjust(1);
    yield* Fiber.join(second);
    assert.deepEqual(times, [0, 1000]);
    const short = yield* client.session(1999);
    yield* short.resolve("Street 1", "1234");
    const deadline = yield* Effect.either(short.resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(deadline) && deadline.left instanceof ResolutionError);
    const expired = yield* client.session(0);
    assert.ok(Either.isLeft(yield* Effect.either(expired.resolve("Street 1", "1234"))));
    session.requests = 10;
    const budget = yield* Effect.either(session.resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(budget) && budget.left instanceof ResolutionError);
  }).pipe(Effect.provide(addressLayer(() => Effect.gen(function* () {
    times.push(yield* monotonicMillis);

 return wire(match());
  }))), Effect.provide(TestContext.TestContext)));
  await Effect.runPromise(Effect.gen(function* () {
    const address = yield* (yield* AddressClient).session();
    const result = yield* Effect.either(address.resolve("Street 1", "1234"));
    assert.ok(Either.isLeft(result) && result.left instanceof ResolutionError);
  }).pipe(Effect.provide(addressLayer(() => TestClock.adjust(90_000).pipe(Effect.as(wire(match()))))), Effect.provide(TestContext.TestContext)));
};

export const bindingCase = () => storeCase((sql) => Effect.gen(function* () {
  const before = yield* sql`SELECT * FROM ads ORDER BY uuid`;
  const nav = yield* navSession();
  const first = yield* resolve(sql, nav, yield* addressSession(match(false)));
  assert.equal(first.resolved, 1);
  const stored = (yield* sql<{ points: string; provenance: string; incomplete: number }>`SELECT points, provenance, incomplete FROM ad_locations WHERE uuid=${id}`)[0]!;
  assert.deepEqual(JSON.parse(stored.points), [[61.2, 11.3]]);
  const provenance = JSON.parse(stored.provenance);
  assert.deepEqual(provenance.provider_stedfestingverifisert, [false]);
  assert.equal(provenance.workplace_fingerprint.uuid, id);
  assert.equal(provenance.workplace_fingerprint.detail_version_source, "source_changed_fallback");
  assert.ok(!stored.provenance.includes("Street") && !stored.provenance.includes("1234"));
  assert.deepEqual(yield* sql`SELECT * FROM ads ORDER BY uuid`, before);
  assert.equal((yield* resolve(sql, nav, yield* addressSession())).attempted, 0);

  const changes: readonly [string, string, number][] = [
    ["[[61.3,11.3]]", stored.provenance, 0], // Transplanted points.
    [stored.points, stored.provenance.replace(id, other), 0],
    [stored.points, stored.provenance.replaceAll(changed, later), 0],
    [stored.points, JSON.stringify({ ...provenance, workplace_fingerprint: { ...provenance.workplace_fingerprint, sha256: "invalid" } }), 0],
    [stored.points, '{"method":"legacy"}', 0],
    [stored.points, stored.provenance, 1],
  ];

  for (const [points, prov, incomplete] of changes) {
    yield* sql`UPDATE ad_locations SET points=${points}, provenance=${prov}, incomplete=${incomplete} WHERE uuid=${id}`;
    assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).resolved, 1, prov);
  }

  // A changed detail-evidence binding must not pass the complete-row skip.
  yield* sql`INSERT INTO ad_detail_versions VALUES (${id}, ${changed}, ${changed})`;
  assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).resolved, 1);
  assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).attempted, 0);
  yield* sql`UPDATE ad_detail_versions SET detail_changed=${later} WHERE uuid=${id}`;
  const stale = yield* resolve(sql, yield* navSession(), yield* addressSession());
  assert.equal(stale.attempted, 1); assert.equal(stale.version_mismatch, 1);
  yield* sql`DROP TABLE ad_detail_versions`;
  yield* sql`DELETE FROM ad_locations`;
  assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).resolved, 1);
}));

export const casCase = async () => {
  for (const mutation of ["ad-title", "ad-observed", "ad-extra", "ad-own-proto", "delete-ad", "version", "delete-version", "detail", "delete-detail"]) await storeCase((sql, second) => Effect.gen(function* () {
    yield* sql`ALTER TABLE ads ADD COLUMN extra TEXT`;
    yield* sql`UPDATE ads SET extra='retained'`;
    yield* sql`ALTER TABLE ads ADD COLUMN "__proto__" TEXT`;
    yield* sql`UPDATE ads SET "__proto__"='retained'`;
    yield* sql`INSERT INTO ad_detail_versions VALUES (${id}, ${changed}, ${changed})`;
    yield* sql`INSERT INTO ad_locations VALUES (${id}, ${"[[1,2]]"}, ${1}, ${"prior evidence"})`;

    const nav = yield* navSession(() => Effect.sync(() => {
      // The independent writer can commit: the resolver holds no transaction over HTTP.
      if (mutation === "ad-title") second.query("UPDATE ads SET title='Changed' WHERE uuid=?").run(id);

      if (mutation === "ad-observed") second.query("UPDATE ads SET observed=? WHERE uuid=?").run(later, id);

      if (mutation === "ad-extra") second.query("UPDATE ads SET extra='changed' WHERE uuid=?").run(id);

      if (mutation === "ad-own-proto") second.query('UPDATE ads SET "__proto__"=? WHERE uuid=?').run("changed", id);

      if (mutation === "delete-ad") second.query("DELETE FROM ads WHERE uuid=?").run(id);

      if (mutation === "version") second.query("UPDATE versions SET changed=? WHERE uuid=?").run(later, id);

      if (mutation === "delete-version") second.query("DELETE FROM versions WHERE uuid=?").run(id);

      if (mutation === "detail") second.query("UPDATE ad_detail_versions SET detail_changed=? WHERE uuid=?").run(later, id);

      if (mutation === "delete-detail") second.query("DELETE FROM ad_detail_versions WHERE uuid=?").run(id);

      return detail();
    }));

    const seen: string[] = [];
    const result = yield* resolve(sql, nav, yield* addressSession(), { checkpoint: (uuid) => Effect.sync(() => { seen.push(uuid); }) });
    assert.equal(result.resolved, 0, mutation); assert.equal(result.unknown, 1, mutation); assert.equal(result.version_mismatch, 1, mutation);
    const rows = yield* sql<{ provenance: string }>`SELECT provenance FROM ad_locations WHERE uuid=${id}`;
    assert.deepEqual(rows, mutation === "delete-ad" ? [] : [{ provenance: "prior evidence" }], mutation);
    assert.deepEqual(seen, [id]);
    // The connection is not left in an open transaction after the failed CAS.
    yield* sql`BEGIN IMMEDIATE`; yield* sql`ROLLBACK`;
  }));
};

export const rollbackCase = () => storeCase((sql) => Effect.gen(function* () {
  yield* sql`CREATE TABLE transaction_probe (value TEXT)`;
  yield* sql.unsafe("CREATE TRIGGER fail_location BEFORE INSERT ON ad_locations BEGIN INSERT INTO transaction_probe VALUES ('must roll back'); SELECT RAISE(ABORT,'synthetic write failure'); END");
  const seen: string[] = [];
  const result = yield* Effect.either(resolve(sql, yield* navSession(), yield* addressSession(), { checkpoint: (uuid) => Effect.sync(() => { seen.push(uuid); }) }));
  assert.ok(Either.isLeft(result));
  assert.deepEqual(seen, [id]);
  assert.deepEqual(yield* sql`SELECT * FROM ad_locations`, []);
  assert.deepEqual(yield* sql`SELECT * FROM transaction_probe`, []);
  yield* sql`DROP TRIGGER fail_location`;
  // Hold this client's native reservation while another fiber starts resolution.
  // No statement from that fiber may enter the caller's transaction.
  let network = false;

  const nav = yield* navSession(() => Effect.sync(() => { network = true;

 return detail(); }));

  const address = yield* addressSession();
  const gate = yield* Deferred.make<void>();
  const fiber = yield* Effect.fork(Deferred.await(gate).pipe(Effect.zipRight(resolve(sql, nav, address))));
  yield* withReservedConnection(sql, Effect.gen(function* () {
    yield* sql`BEGIN IMMEDIATE`;
    yield* Deferred.succeed(gate, undefined);
    yield* Effect.yieldNow(); yield* Effect.yieldNow();
    assert.equal(network, false);
    yield* sql`ROLLBACK`;
  }));
  yield* Fiber.join(fiber);
  assert.equal(network, true);
  assert.equal((yield* sql`SELECT * FROM ad_locations`).length, 1);
}));

export const ownedCase = () => storeCase((sql, _second, path) => Effect.gen(function* () {
  yield* sql`CREATE TABLE transaction_probe (value TEXT)`;

  const rolled = yield* Effect.either(sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO transaction_probe VALUES ('outer-rolled-back')`;
    const result = yield* resolve(sql, yield* navSession(), yield* addressSession());
    assert.equal(result.resolved, 1);
    assert.equal((yield* sql`SELECT * FROM ad_locations`).length, 1);

    return yield* Effect.fail("caller rollback");
  })));

  assert(Either.isLeft(rolled)); assert.equal(rolled.left, "caller rollback");
  assert.deepEqual(yield* sql`SELECT * FROM ad_locations`, []);
  assert.deepEqual(yield* sql`SELECT * FROM transaction_probe`, []);
  const discarded = yield* readSnapshot(sql, resolve(sql, yield* navSession(), yield* addressSession()));
  assert.equal(discarded.resolved, 1);
  assert.deepEqual(yield* sql`SELECT * FROM ad_locations`, []);
  yield* Effect.scoped(Effect.gen(function* () {
    const readonly = yield* acquireSqliteResource({ filename: path, readonly: true, readwrite: false, create: false });
    yield* readonly`PRAGMA query_only = 1`;
    const failed = yield* Effect.either(readSnapshot(readonly, resolve(readonly, yield* navSession(), yield* addressSession())));
    assert(Either.isLeft(failed)); assert(Predicate.isTagged(failed.left, "SqlError"));
  })).pipe(Effect.provide(Reactivity.layer));
  assert.equal((yield* sql`PRAGMA query_only`)[0]?.query_only, 0);
  assert.deepEqual(yield* sql`SELECT * FROM ad_locations`, []);
  yield* sql.unsafe("CREATE TRIGGER fail_nested_location BEFORE INSERT ON ad_locations BEGIN INSERT INTO transaction_probe VALUES ('nested-failed'); SELECT RAISE(ABORT,'synthetic nested failure'); END");
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO transaction_probe VALUES ('outer-before')`;
    const failed = yield* Effect.either(resolve(sql, yield* navSession(), yield* addressSession()));
    assert(Either.isLeft(failed)); assert(Predicate.isTagged(failed.left, "SqlError"));
    assert.deepEqual(yield* sql`SELECT * FROM ad_locations`, []);
    assert.deepEqual(yield* sql`SELECT * FROM transaction_probe`, [{ value: "outer-before" }]);
    yield* sql`DROP TRIGGER fail_nested_location`;
    yield* sql`INSERT INTO transaction_probe VALUES ('outer-after')`;
  }));
  assert.deepEqual(yield* sql`SELECT * FROM transaction_probe`, [{ value: "outer-before" }, { value: "outer-after" }]);
  const standalone = yield* resolve(sql, yield* navSession(), yield* addressSession());
  assert.equal(standalone.resolved, 1); assert.equal(standalone.version_mismatch, 0);
  assert.equal((yield* sql`SELECT * FROM ad_locations`).length, 1);
}));

export const classificationCase = () => storeCase((sql) => Effect.gen(function* () {
  const cases: readonly [string, SourceObject | null, number, number][] = [
    ["null", null, 1, 0],
    ["content absent", { ...detail(), ad_content: null }, 1, 0],
    ["missing updated", { ...detail(), ad_content: { ...content(detail()), updated: null } }, 1, 0],
    ["bad updated and wrapper", { ...detail(), sistEndret: later, ad_content: { ...content(detail()), updated: "bad" } }, 1, 0],
    ["bad wrapper", { ...detail(), sistEndret: "bad" }, 1, 0],
    ["wrapper mismatch", { ...detail(), sistEndret: later }, 0, 1],
    ["wrong identity", { ...detail(), uuid: other }, 0, 0],
    ["wrong content identity", { ...detail(), ad_content: { ...content(detail()), uuid: other } }, 0, 0],
    ["inactive", { ...detail(), status: "INACTIVE" }, 0, 0],
    ["title mismatch", { ...detail(), ad_content: { ...content(detail()), title: "Other" } }, 0, 0],
    ["employer missing name", { ...detail(), ad_content: { ...content(detail()), employer: {} } }, 0, 0],
    ["non-object location", { ...detail(), ad_content: { ...content(detail()), workLocations: [null] } }, 0, 0],
    ["too many", { ...detail(), ad_content: { ...content(detail()), workLocations: Array.from({ length: 101 }, () => workplace) } }, 0, 0],
    ["bad expires", { ...detail(), ad_content: { ...content(detail()), expires: "bad" } }, 0, 0],
  ];

  for (const [name, value, unsupported, mismatch] of cases) {
    const address = yield* addressSession();
    const result = yield* resolve(sql, yield* navSession(() => Effect.succeed(value)), address);
    assert.equal(result.unknown, 1, name); assert.equal(result.unsupported_detail, unsupported, name); assert.equal(result.version_mismatch, mismatch, name); assert.equal(address.requests, 0, name);
  }

  // A later feed marker is valid only with exact ingestion detail evidence.
  yield* sql`UPDATE ads SET changed=${later} WHERE uuid=${id}`;
  yield* sql`UPDATE versions SET changed=${later} WHERE uuid=${id}`;
  assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).version_mismatch, 1);
  yield* sql`INSERT INTO ad_detail_versions VALUES (${id}, ${later}, ${changed})`;
  assert.equal((yield* resolve(sql, yield* navSession(), yield* addressSession())).resolved, 1);
  yield* sql`DELETE FROM ad_locations`;
  yield* sql`UPDATE ad_detail_versions SET saved_changed=${changed} WHERE uuid=${id}`;
  const nav = yield* navSession();
  assert.equal((yield* resolve(sql, nav, yield* addressSession())).version_mismatch, 1);
  assert.equal(nav.requests, 0);
}));

export const checkpointsCase = () => storeCase((sql) => Effect.gen(function* () {
  const seen: string[] = [];
  const checkpoint = (uuid: string) => Effect.sync(() => { seen.push(uuid); });
  const transient = yield* Effect.either(resolve(sql, yield* navSession(() => Effect.fail(new SourceError({ message: "synthetic temporary", transient: true }))), yield* addressSession(), { checkpoint }));
  assert.ok(Either.isLeft(transient)); assert.deepEqual(seen, []);
  const addressFailure = yield* (yield* AddressClient).session();
  const outage = yield* Effect.either(resolve(sql, yield* navSession(), addressFailure, { checkpoint }));
  assert.ok(Either.isLeft(outage)); assert.deepEqual(seen, []);
  const permanent = yield* resolve(sql, yield* navSession(() => Effect.fail(new SourceError({ message: "synthetic definite" }))), yield* addressSession(), { checkpoint });
  assert.equal(permanent.unknown, 1); assert.deepEqual(seen, [id]);
  // AddressClient's own in-flight time exhaustion is permanent in the frozen module.
  const expiringAddress = yield* addressSession();
  const delayed = yield* navSession(() => TestClock.adjust(90_000).pipe(Effect.as(detail())));
  assert.equal((yield* resolve(sql, delayed, expiringAddress, { checkpoint })).unknown, 1);
  assert.deepEqual(seen, [id, id]);
  const depletedAddress = yield* addressSession();

  const depletingNav = yield* navSession(() => Effect.sync(() => { depletedAddress.requests = 10;

 return detail(); }));

  // The combined budget breaks the location loop rather than making request eleven.
  assert.equal((yield* resolve(sql, depletingNav, depletedAddress, { checkpoint })).unknown, 1);
  assert.deepEqual(seen, [id, id, id]);
  const definiteAddress = yield* Effect.flatMap(AddressClient, (client) => client.session()).pipe(Effect.provide(addressLayer(() => Effect.succeed(wire({}, 400)))));
  assert.equal((yield* resolve(sql, yield* navSession(), definiteAddress, { checkpoint })).unknown, 1);
  assert.deepEqual(seen, [id, id, id, id]);
  // Unknown rows rotate fairly, including a cursor that is not in the candidate set.
  const jobs = [{ uuid: other }, ...candidates];
  const first = yield* resolveCandidates(sql, yield* navSession(() => Effect.succeed(null)), yield* addressSession(), jobs, 1, { now: changed, after: "absent", checkpoint });
  const second = yield* resolveCandidates(sql, yield* navSession(() => Effect.succeed(null)), yield* addressSession(), jobs, 1, { now: changed, after: first.last_uuid!, checkpoint });
  assert.equal(first.last_uuid, id); assert.equal(second.last_uuid, other);
  assert.deepEqual(seen.slice(-2), [id, other]);
}).pipe(Effect.provide(addressLayer(() => Effect.fail(new SourceError({ message: "synthetic outage", transient: true }))))));

const budgetNavLayer = NavClientLive.pipe(Layer.provide(Layer.succeed(SourceHttp, {
  request: (url) => Effect.succeed(url.endsWith("/api/publicToken") ? wire("eyJsynthetic.payload.signature")
    : wire({ ...detail(), ad_content: { ...content(detail()), workLocations: Array.from({ length: 15 }, () => workplace) } })),
})));

export const budgetCase = () => storeCase((sql) => Effect.gen(function* () {
  const seen: string[] = [];

  for (const kind of ["requests", "auth", "time"]) {
    const nav = yield* navSession(); const address = yield* addressSession();

    if (kind === "requests") nav.requests = 10;

    if (kind === "auth") { nav.requests = 9; nav.token = null; }

    if (kind === "time") yield* TestClock.adjust(90_000);
    const result = yield* resolve(sql, nav, address, { after: other, checkpoint: (uuid) => Effect.sync(() => { seen.push(uuid); }) });
    assert.equal(result.attempted, 0); assert.equal(result.last_uuid, other);
  }

  assert.deepEqual(seen, []);
  // Exercise the real NAV client's token + detail counters and the shared ten-request cap.
  const nav = yield* (yield* NavClient).session({ maxRequests: 10, seconds: 90 });
  const address = yield* addressSession();
  // Unique physical duplicates are intentionally retained in both points and flags.
  const fiber = yield* Effect.fork(resolveCandidates(sql, nav, address, [{ uuid: id }, { uuid: other }], 2, { now: changed }));
  yield* TestClock.adjust(10_000);
  const result = yield* Fiber.join(fiber);
  assert.equal(nav.requests, 2); assert.equal(address.requests, 8); assert.equal(result.attempted, 1); assert.equal(result.resolved, 1);
  const stored = (yield* sql<{ points: string; incomplete: number; provenance: string }>`SELECT * FROM ad_locations WHERE uuid=${id}`)[0]!;
  assert.equal(JSON.parse(stored.points).length, 8); assert.equal(stored.incomplete, 1);
  assert.equal(JSON.parse(stored.provenance).provider_stedfestingverifisert.length, 8);
}).pipe(Effect.provide(budgetNavLayer)));

export const partialCase = () => storeCase((sql) => Effect.gen(function* () {
  for (const [locations, expectedPoints, incomplete] of [
    [[workplace, workplace], 2, 0],
    [[workplace, { ...workplace, country: "Sverige" }], 1, 1],
    [[workplace, { ...workplace, country: null }], 1, 1],
    [[workplace, { municipal: "Oslo", address: "Street 1", postalCode: "1234" }], 1, 1],
    [[workplace, { ...workplace, address: "Region only" }], 1, 1],
    [[{ ...workplace, country: "Sverige" }], 0, 0],
    [[], 0, 0],
  ] as const) {
    yield* sql`DELETE FROM ad_locations`;
    const nav = yield* navSession(() => Effect.succeed({ ...detail(), ad_content: { ...content(detail()), workLocations: locations } }));
    const address = yield* addressSession(match(null));
    const fiber = yield* Effect.fork(resolve(sql, nav, address));
    yield* TestClock.adjust(2000);
    const result = yield* Fiber.join(fiber);
    assert.equal(result.resolved, expectedPoints > 0 ? 1 : 0);
    assert.equal(result.unknown, expectedPoints > 0 ? 0 : 1);
    const stored = (yield* sql<{ points: string; incomplete: number; provenance: string }>`SELECT * FROM ad_locations WHERE uuid=${id}`)[0];

    if (expectedPoints) {
      assert.ok(stored); assert.equal(JSON.parse(stored.points).length, expectedPoints); assert.equal(stored.incomplete, incomplete);
      assert.deepEqual(JSON.parse(stored.provenance).provider_stedfestingverifisert, Array.from({ length: expectedPoints }, () => null));
    } else assert.equal(stored, undefined);
  }
}));

export const multipleCase = () => storeCase((sql) => Effect.gen(function* () {
  const nav = yield* navSession(() => Effect.succeed({ ...detail(), ad_content: { ...content(detail()), workLocations: [workplace, { ...workplace, address: "Street 2" }] } }));
  const address = yield* Effect.flatMap(AddressClient, (client) => client.session());
  const fiber = yield* Effect.fork(resolve(sql, nav, address));
  yield* TestClock.adjust(2000);
  assert.equal((yield* Fiber.join(fiber)).resolved, 1);
  const stored = (yield* sql<{ points: string; incomplete: number; provenance: string }>`SELECT * FROM ad_locations WHERE uuid=${id}`)[0]!;
  assert.deepEqual(JSON.parse(stored.points), [[61.2, 11.3], [62, 12]]);
  assert.equal(stored.incomplete, 0);
  assert.deepEqual(JSON.parse(stored.provenance).provider_stedfestingverifisert, [true, false]);
}).pipe(Effect.provide(addressLayer((url) => Effect.sync(() => {
  const response = match();

  if (new URL(url).searchParams.get("adressetekst") === "Street 2") Object.assign(response.adresser[0]!, { adressetekst: "Street 2", stedfestingverifisert: false, representasjonspunkt: { epsg: "4326", lat: 62, lon: 12 } });

  return wire(response);
})))));

export const schemasCase = () => storeCase((sql) => Effect.gen(function* () {
  assert.equal(Schema.is(AddressResolution)({ coordinates: [true, 1], provider_stedfestingverifisert: true }), false);
  assert.equal(Schema.is(ResolutionResult)({ attempted: -1, resolved: 0, unknown: 0, version_mismatch: 0, unsupported_detail: 0, last_uuid: null }), false);
  assert.equal(Schema.is(ResolutionInput)({ candidates, limit: 1.5, options: {} }), false);
  const nav = yield* navSession(); const address = yield* addressSession();

  for (const limit of [0, 11, 1.5, NaN]) assert.ok(Either.isLeft(yield* Effect.either(resolveCandidates(sql, nav, address, candidates, limit))));
  yield* sql`DROP TABLE ad_locations`;
  const missing = yield* Effect.either(resolve(sql, nav, address));
  assert.ok(Either.isLeft(missing) && missing.left instanceof ResolutionError); assert.equal(nav.requests, 0);
  yield* sql`CREATE TABLE ad_locations (uuid TEXT, points TEXT, incomplete INTEGER, provenance TEXT)`;
  yield* sql`PRAGMA ignore_check_constraints=ON`;
  yield* sql`UPDATE ads SET detail_missing='not an integer' WHERE uuid=${id}`;
  const invalid = yield* Effect.either(resolve(sql, nav, address));
  assert.ok(Either.isLeft(invalid) && invalid.left instanceof ResolutionError); assert.equal(nav.requests, 0);
}));
