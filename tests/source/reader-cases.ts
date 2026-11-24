import { Effect, Either, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { acquireStore, readSnapshot } from "../../src/lib/server/source/store.ts";
import { currentOccupationPairs, hasDetailVersions, readApplicationDeadline, readCurrentAd, readHistoricalAd, readManifest, readManifestSnapshot, readRelevance, readStatus, readVersion, sourceState, sourceTables } from "../../src/lib/server/source/readers.ts";
import { CurrentAdEvidence, ManifestSourceSnapshot, SourceAd } from "../../src/lib/contracts/source-readers.ts";
import { pythonJson, sha256 } from "../../src/lib/server/shared/python-json.ts";

const path = process.argv[2]!;
const now = "2026-10-19T09:00:00+00:00";
const id = "00000000-0000-0000-0000-000000000001";

const program = Effect.scoped(Effect.gen(function* () {
  const sql = yield* acquireStore(path, "create");
  yield* sql`PRAGMA journal_mode=WAL`;
  yield* sql`CREATE TABLE state (key TEXT, value TEXT)`;
  yield* sql`INSERT INTO state VALUES ('checked',${now})`;
  yield* sql`CREATE TABLE ads (uuid TEXT, changed TEXT, first_seen TEXT, observed TEXT, title TEXT, employer TEXT, locations TEXT, topics TEXT, detail_missing INTEGER, expires TEXT, source TEXT, extra TEXT)`;
  yield* sql`CREATE TABLE versions (uuid TEXT, changed TEXT)`;
  yield* sql`CREATE TABLE ad_application_deadlines (uuid TEXT, changed TEXT, application_due TEXT)`;
  yield* sql`CREATE TABLE ad_status_evidence (uuid TEXT, status TEXT, changed TEXT)`;
  yield* sql`INSERT INTO ads VALUES (${id},${now},'f','o','t','e','[]','[]',1,NULL,NULL,'retained')`;
  yield* sql`INSERT INTO versions VALUES (${id},${now})`;
  yield* sql`INSERT INTO ad_application_deadlines VALUES (${id},${now},NULL)`;
  yield* sql`INSERT INTO ad_status_evidence VALUES (${id},'STOPPED',${now})`;
  assert.equal(yield* hasDetailVersions(sql), false);
  const current = yield* readCurrentAd(sql, id, false);
  assert.equal(current.ad?.detail_missing, 1);
  assert.equal(current.ad?.extra, "retained");
  assert.equal(current.has_location_points, false);
  assert.deepEqual(current.occupation_pairs, []);
  assert.equal(Schema.is(CurrentAdEvidence)(current), true);
  assert.deepEqual(yield* readHistoricalAd(sql, id), current.ad);
  assert.equal(yield* readHistoricalAd(sql, "absent"), null);
  assert.equal((yield* readCurrentAd(sql, "absent", false)).version_exists, false);
  assert.deepEqual(yield* readApplicationDeadline(sql, id), [now, null, 0]);
  assert.equal(yield* readApplicationDeadline(sql, "absent"), null);
  yield* sql`ALTER TABLE ad_application_deadlines ADD COLUMN rolling INTEGER DEFAULT 0`;
  yield* sql`UPDATE ad_application_deadlines SET rolling=1,application_due='snarest'`;
  assert.deepEqual(yield* readApplicationDeadline(sql, id), [now, "snarest", 1]);
  assert.deepEqual(yield* readStatus(sql, id), ["STOPPED", now]);
  assert.equal(yield* readStatus(sql, "absent"), null);
  assert.equal(yield* readVersion(sql, id), now);
  assert.equal(yield* readVersion(sql, "absent"), null);
  assert.equal((yield* sourceTables(sql)).has("ads"), true);
  assert.deepEqual(yield* currentOccupationPairs(sql), {});
  // A malformed ad must not be loaded when the count already exceeds the cap.
  yield* sql`UPDATE ads SET title=NULL`;
  const limited = yield* readSnapshot(sql, readManifestSnapshot(sql, 0, now));
  assert.equal(limited.listing_count, 1);
  assert.deepEqual(limited.ads, []);
  assert.equal(Schema.is(ManifestSourceSnapshot)(limited), true);
  assert.equal(Either.isLeft(yield* Effect.either(readRelevance(sql, now))), true);
  yield* sql`UPDATE ads SET title='t'`;
  assert.equal((yield* readRelevance(sql, now)).ads[0]?.extra, "retained");
  const withoutOptionalTables = yield* readManifestSnapshot(sql, 1, now);
  assert.deepEqual(withoutOptionalTables.location_points, {});
  assert.deepEqual(withoutOptionalTables.occupation_pairs, {});
  assert.deepEqual(withoutOptionalTables.location_binding_digests, {});
  yield* sql`UPDATE ads SET expires=${now}`;
  assert.equal((yield* readRelevance(sql, "2026-10-19T11:00:00+02:00")).ads.length, 0);
  assert.equal((yield* readManifestSnapshot(sql, 1, "2026-10-19T09:00:00Z")).ads.length, 0);
  assert.equal((yield* readRelevance(sql, "2026-10-19T08:59:59Z")).ads.length, 1);
  assert.equal(Either.isLeft(yield* Effect.either(readRelevance(sql, "2026-10-19T09:00:00"))), true);
  yield* sql`UPDATE ads SET expires=NULL`;
  yield* sql`CREATE TABLE ad_occupations (uuid TEXT, scheme TEXT, level1 TEXT, level2 TEXT)`;
  assert.deepEqual(yield* currentOccupationPairs(sql), {});
  yield* sql`CREATE TABLE ad_occupation_checks (uuid TEXT, saved_changed TEXT)`;
  yield* sql`INSERT INTO ad_occupation_checks VALUES (${id},'stale')`;
  assert.deepEqual(yield* currentOccupationPairs(sql), {});
  yield* sql`UPDATE ad_occupation_checks SET saved_changed=${now}`;
  assert.deepEqual(yield* currentOccupationPairs(sql), { [id]: [] });
  yield* sql`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','\u{10000}','one'), (${id},'occupationCategories','\uE000','two'), (${id},'occupationCategories','\uE000','two'), (${id},'occupationCategories','','ignored'), (${id},'other','ignored','ignored')`;
  const ordered = [["\uE000", "two"], ["\u{10000}", "one"]];
  assert.deepEqual((yield* readCurrentAd(sql, id, false)).occupation_pairs, ordered);
  assert.deepEqual(yield* currentOccupationPairs(sql), { [id]: ordered });
  yield* sql`UPDATE versions SET changed='stale'`;
  assert.deepEqual(yield* currentOccupationPairs(sql), {});
  const missingVersion = yield* readCurrentAd(sql, id, false);
  assert.equal(missingVersion.version_exists, true);
  assert.equal(missingVersion.version_changed, "stale");
  yield* sql`DELETE FROM versions`;
  assert.equal((yield* readCurrentAd(sql, id, false)).version_exists, false);
  yield* sql`INSERT INTO versions VALUES (${id},${now})`;
  yield* sql`CREATE TABLE ad_detail_versions (uuid TEXT, saved_changed TEXT, detail_changed TEXT)`;
  assert.equal((yield* readCurrentAd(sql, id, true)).detail_evidence, null);
  yield* sql`INSERT INTO ad_detail_versions VALUES (${id},${now},${now})`;
  assert.equal(yield* hasDetailVersions(sql), true);
  assert.deepEqual((yield* readCurrentAd(sql, id, true)).detail_evidence, { saved_changed: now, detail_changed: now });
  assert.equal((yield* readCurrentAd(sql, id, false)).detail_evidence, null);
  yield* sql`CREATE TABLE ad_locations (uuid TEXT, points TEXT, incomplete INTEGER, provenance TEXT)`;
  // Construct provenance independently: do not generate the expected binding with the verifier.
  const pointsJson = "[[60.0, 10.0]]";

  const workplaceDigest = sha256(pythonJson({
    version: 1,
    work_locations: { state: "list", items: [{
      state: "location", address: { state: "valid", value: "testgata 1" },
      postal_code: { state: "valid", value: "0001" }, country: { state: "norwegian" },
    }] },
  }));

  const provenance = {
    provider: "https://ws.geonorge.no/adresser/v1/sok", method: "exact_unique_address_postcode_epsg4326_approximate",
    source_version: now, retrieved_at: now, provider_stedfestingverifisert: [true],
    workplace_fingerprint: {
      version: 1, sha256: workplaceDigest, point_digest_version: 1, points_sha256: sha256(pointsJson),
      uuid: id, source_version: now, detail_version_source: "ad_detail_versions", detail_changed: now,
      detail_saved_changed: now, incomplete: false,
    },
  };

  const provenanceJson = JSON.stringify(provenance);
  const digest = sha256(pythonJson(provenance));
  yield* sql`INSERT INTO ad_locations VALUES (${id},${pointsJson},0,${provenanceJson})`;
  const manifest = yield* readSnapshot(sql, readManifestSnapshot(sql, 1, now));
  assert.equal(manifest.location_binding_digests[id], digest);
  assert.deepEqual(manifest.location_points[id], [[[60, 10]], false]);
  assert.equal(manifest.occupation_pairs[id]?.length, 3); // Manifest retains raw order and duplicates.
  assert.equal(manifest.ads[0]?.extra, "retained");
  const evidence = yield* readCurrentAd(sql, id, true);
  assert.equal(evidence.has_location_points, true);
  assert.equal(evidence.location_evidence?.provenance, provenanceJson);
  yield* sql`UPDATE ad_locations SET points='[[61.0, 10.0]]'`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE ad_locations SET points=${pointsJson}`;
  yield* sql`UPDATE ad_detail_versions SET saved_changed='stale'`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE ad_detail_versions SET saved_changed=${now},detail_changed='stale'`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE ad_detail_versions SET detail_changed=${now}`;
  yield* sql`UPDATE versions SET changed='stale'`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE versions SET changed=${now}`;
  const transplanted = JSON.stringify({ ...provenance, workplace_fingerprint: { ...provenance.workplace_fingerprint, uuid: "00000000-0000-0000-0000-000000000002" } });
  yield* sql`UPDATE ad_locations SET provenance=${transplanted}`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE ad_locations SET provenance=${provenanceJson},incomplete=1`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  yield* sql`UPDATE ad_locations SET incomplete=0`;
  yield* sql`DROP TABLE ad_detail_versions`;

  const fallback = JSON.stringify({ ...provenance, workplace_fingerprint: {
    ...provenance.workplace_fingerprint, detail_version_source: "source_changed_fallback", detail_saved_changed: null,
  } });

  yield* sql`UPDATE ad_locations SET provenance=${fallback}`;
  assert.equal(Object.keys((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests).length, 1);
  yield* sql`UPDATE ad_locations SET provenance=''`;
  assert.deepEqual((yield* readRelevance(sql, now)).location_points, {});
  yield* sql`UPDATE ad_locations SET provenance='invalid',points='not json'`;
  assert.equal(Either.isLeft(yield* Effect.either(readManifestSnapshot(sql, 1, now))), true);
  yield* sql`UPDATE ad_locations SET points='[]'`;
  assert.deepEqual((yield* readManifestSnapshot(sql, 1, now)).location_binding_digests, {});
  // A second real connection writes after the first read pins a WAL snapshot.
  const writer = new Database(path);

  try {
    yield* readSnapshot(sql, Effect.gen(function* () {
      assert.equal((yield* sourceState(sql)).checked, now);
      writer.run("UPDATE state SET value='later'");
      writer.run("UPDATE ads SET title='later'");
      const saved = yield* readManifestSnapshot(sql, 1, now);
      assert.equal(saved.state.checked, now);
      assert.equal(saved.ads[0]?.title, "t");
    }));
  } finally {
    writer.close();
  }

  assert.equal((yield* sourceState(sql)).checked, "later");
  const readonlySnapshot = yield* readManifest(path, 1, now);
  assert.equal(readonlySnapshot.ads[0]?.title, "later");
  const absent = path + ".absent";
  assert.equal(Either.isLeft(yield* Effect.either(readManifest(absent, 1, now))), true);
  assert.equal(existsSync(absent), false);
  // SQL columns and dictionary keys are data, including reserved JS property names.
  yield* sql`ALTER TABLE ads ADD COLUMN "__proto__" TEXT`;
  yield* sql`UPDATE ads SET "__proto__"='retained-own-column'`;
  yield* sql`INSERT INTO state VALUES ('__proto__','retained-own-state')`;
  yield* sql`INSERT INTO ad_locations VALUES ('__proto__','[]',0,'invalid')`;
  yield* sql`INSERT INTO ad_occupations VALUES ('__proto__','occupationCategories','own','pair')`;
  const ownKeys = yield* readManifestSnapshot(sql, 1, now);
  assert.equal(Object.hasOwn(ownKeys.ads[0]!, "__proto__"), true);
  assert.equal(ownKeys.ads[0]?.["__proto__"], "retained-own-column");
  assert.equal(Object.getPrototypeOf(ownKeys.ads[0]), Object.prototype);
  assert.equal(ownKeys.state["__proto__"], "retained-own-state");
  assert.deepEqual(ownKeys.location_points["__proto__"], [[], false]);
  assert.deepEqual(ownKeys.occupation_pairs["__proto__"], [["own", "pair"]]);

  for (const value of [ownKeys.state, ownKeys.location_points, ownKeys.occupation_pairs]) {
    assert.equal(Object.hasOwn(value, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
  }

  assert.equal((yield* readCurrentAd(sql, id, false)).ad?.["__proto__"], "retained-own-column");
  // Generic historical/current adapters must also preserve a minimal, extended row.
  yield* sql`DROP TABLE ads`;
  yield* sql`CREATE TABLE ads (uuid TEXT, changed TEXT, title TEXT, extra TEXT)`;
  yield* sql`INSERT INTO ads VALUES (${id},${now},'minimal','retained')`;
  assert.deepEqual(yield* readHistoricalAd(sql, id), { uuid: id, changed: now, title: "minimal", extra: "retained" });
  assert.equal((yield* readCurrentAd(sql, id, false)).ad?.extra, "retained");
  yield* sql`DELETE FROM ads`;
  const missingAd = yield* readCurrentAd(sql, id, false);
  assert.equal(missingAd.ad, null);
  assert.equal(missingAd.version_exists, true);
  assert.equal(Schema.is(SourceAd)({ uuid: id, changed: now }), false);
}));

await Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));
