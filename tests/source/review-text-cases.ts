import assert from "node:assert/strict";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Option } from "effect";
import { checkSourceVersion, fetchCurrentAdTexts, snapshotDigest, sourceListing, reviewSourceReader, type ReviewSourceReader } from "../../src/lib/server/source/review-text.ts";
import { NavClientReplay, type NavSession } from "../../src/lib/server/source/nav-client.ts";
import { SourceError } from "../../src/lib/server/source/errors.ts";
import { fingerprintWorkLocations, workplaceBinding, verifyWorkplaceEvidence, SUPPORTED_METHOD, SUPPORTED_PROVIDER } from "../../src/lib/server/shared/workplace-fingerprint.ts";
import { sourceJson, type SourceObject } from "../../src/lib/server/source/core.ts";
import type { SourceListing } from "../../src/lib/contracts/source-review.ts";

const id = "6f6b830b-16d7-40e4-920a-26f278eab31d";
const version = "2026-10-19T09:00:00+00:00";
const newer = "2026-10-19T09:30:00+00:00";
const now = new Date("2026-10-21T00:00:00Z");
const row = { uuid: id, changed: version, title: "Analyst", employer: "Example", locations: '["Oslo"]', expires: null };

const detail = (changed = version, changes: SourceObject = {}): SourceObject => ({ uuid: id, status: "ACTIVE", sistEndret: changed,
  ad_content: { uuid: id, updated: version, title: "Analyst", employer: { name: "Example" }, workLocations: [{ municipal: "Oslo" }], expires: null, description: " Text. ", ...changes } });

const listing = (changes: Partial<SourceListing> = {}): SourceListing => ({ ...sourceListing(row, { saved_changed: version, detail_changed: version }, { hasLocationPoints: false, occupationPairs: [] }), ...changes });
const check = (value: SourceObject | null, saved = listing()) => Either.getOrThrow(checkSourceVersion(saved, value, { now }));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function decisionCases() {
  const inheritedIdentity = Either.getOrThrow(sourceJson('{"__proto__":' + JSON.stringify(detail()) + '}'));
  assert.equal(Either.getOrThrow(checkSourceVersion(listing(), inheritedIdentity, { now })).sub_reason, "detail_identity_mismatch");
  const inheritedContent = { ...detail(), ad_content: Object.fromEntries([["__proto__", detail().ad_content]]) };
  const nativeContent = Either.getOrThrow(sourceJson(JSON.stringify(inheritedContent)));
  assert.equal(Either.getOrThrow(checkSourceVersion(listing(), nativeContent, { now })).would_review, false);
  assert.equal(Object.hasOwn(Object.prototype, "uuid"), false);
  fc.assert(fc.property(fc.integer({ min: 0, max: 15_000 }), (length) => {
    const result = check(detail(version, { description: "é".repeat(length) }));
    assert.equal(result.would_review, length > 0 && length <= 10_000);
  }), { numRuns: 50, seed: 74528 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 600 }), (seconds) => {
    const changed = new Date(Date.parse(version) - seconds * 1000).toISOString();
    assert.equal(check(detail(changed), listing({ savedDetailChanged: null, detailEvidence: null })).would_review, seconds <= 300);
  }), { numRuns: 50, seed: 74528 });
  const same = check(detail());
  assert.equal(same.body, "Text.");
  assert.equal(same.provenance, null);
  assert.equal(same.snapshot_id, hash('{"description":"Text.","employer":"Example","expires_at":null,"locations":["Oslo"],"title":"Analyst"}'));
  assert.equal(check(null).sub_reason, "detail_missing");
  assert.equal(check({ ...detail(), status: "DELETED", uuid: "other" }).sub_reason, "detail_missing");
  assert.equal(check({ ...detail(), uuid: "other", status: "INACTIVE" }).sub_reason, "detail_identity_mismatch");
  assert.equal(check({ ...detail(), status: "STOPPED" }).sub_reason, "detail_inactive");
  assert.equal(check({ ...detail(), sistEndret: "bad" }).sub_reason, "detail_mismatch");
  assert.equal(check({ ...detail(), sistEndret: "2026-10-19T09:00:00" }).sub_reason, "detail_mismatch");
  assert.equal(check(detail("2026-10-19T11:00:00+02:00")).would_review, true);

  for (const [changed, accepted] of [["2026-10-19T08:55:00Z", true], ["2026-10-19T08:54:59.999999Z", false], ["2026-10-19T09:00:00Z", true]] as const) {
    assert.equal(check(detail(changed), listing({ savedDetailChanged: null, detailEvidence: null })).would_review, accepted);
  }

  assert.equal(check(detail("2026-10-19T08:59:59Z")).sub_reason, "detail_mismatch");
  assert.equal(check(detail(version, { uuid: "other" })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(version, { updated: null })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(version, { title: "Changed" })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(version, { workLocations: [null] })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(version, { description: null })).sub_reason, "description_missing");
  assert.equal(check(detail(version, { description: "\u001c\u0085\n " })).sub_reason, "description_blank");
  assert.equal(check(detail(version, { description: "\ufeff" })).body, "\ufeff");
  assert.equal(check(detail(version, { description: "é".repeat(10_000) })).would_review, true);
  assert.equal(check(detail(version, { description: "é".repeat(10_001) })).sub_reason, "source_text_too_large");
  assert.equal(check(detail(version, { description: "\ud800" })).sub_reason, "detail_mismatch");
  const invalidFields = checkSourceVersion(listing({ row: { ...row, title: "\ud800" } }), detail(version, { title: "\ud800" }), { now });
  assert(Either.isLeft(invalidFields));
  assert.equal(invalidFields.left.code, "source_text_fetch_failed");
  assert.deepEqual(snapshotDigest({ title: "\ud800" }, "ok"), Either.left("invalid_unicode"));
  assert.equal(check(detail(version, { expires: "2026-10-21T00:00:00Z" }), listing({ row: { ...row, expires: "2026-10-21T00:00:00Z" } })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(newer, { expires: "2026-10-21T00:00:00Z" })).sub_reason, "detail_inactive");
  const fresh = check(detail(newer));
  assert.equal(fresh.would_review, true);
  assert.deepEqual(fresh.provenance, { source: "nav_detail_refresh", previous_changed: version, detail_changed: newer, refreshed_at: "2026-10-21T00:00:00+00:00" });
  assert.deepEqual(fresh.snapshot?.occupation_categories, []);
  assert.equal(check(detail(newer), listing({ savedDetailChanged: "2026-10-19T09:10:00Z" })).provenance?.previous_changed, version);
  assert.equal(check(detail(newer), listing({ row: { ...row, changed: "2026-10-19T10:00:00Z" } })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(newer, { title: "Changed" })).sub_reason, "admission_metadata_changed");
  assert.equal(check(detail(newer, { occupationCategories: [{ level1: "IT" }] })).sub_reason, "admission_metadata_changed");
  assert.equal(check(detail(newer, { occupationCategories: [{ level1: 2n }] })).sub_reason, "admission_metadata_changed");
  assert.equal(check(detail(newer), listing({ occupationPairs: null })).sub_reason, "admission_metadata_changed");
  const expiring = listing({ row: { ...row, expires: "2026-11-05T00:00:00Z" } });

  for (const [expires, reason] of [["2026-11-05T00:00:00Z", null], ["2026-11-01T00:00:00Z", null], ["2026-12-01T00:00:00Z", "admission_metadata_changed"], [null, "admission_metadata_changed"], ["bad", "detail_mismatch"]] as const) {
    assert.equal(check(detail(newer, { expires }), expiring).sub_reason, reason);
  }

  const missingExpiry = detail(newer);
  // SAFETY: detail() constructs an object-valued ad_content fixture.
  const content = { ...missingExpiry.ad_content as SourceObject };
  delete content.expires;
  assert.equal(check({ ...missingExpiry, ad_content: content }).sub_reason, "detail_mismatch");
  let called = 0;
  const changed = detail(newer, { title: "New", employer: { name: "New" }, workLocations: [{ city: "New" }], occupationCategories: [{ level1: " z ", level2: " B " }, { level1: "A" }] });

  const accepted = Either.getOrThrow(checkSourceVersion(listing(), changed, { now, admissionCheck: (content, saved) => {
    called++;
    assert.equal(content._source_detail_changed, newer);
    assert.equal(saved.row.uuid, id);

    return { status: "inside", reason: "B4 synthetic result" };
  } }));

  assert.equal(called, 1);
  // SAFETY: detail() constructs an object-valued ad_content fixture.
  assert.equal((changed.ad_content as SourceObject)._source_detail_changed, undefined);
  assert.equal(accepted.would_review, true);
  assert.deepEqual(accepted.snapshot?.occupation_categories, ["A", "z / B"]);
  assert.equal(accepted.snapshot?.geography_reason, "B4 synthetic result");

  for (const ValidationError of [TypeError, RangeError, SyntaxError]) {
    const rejected = checkSourceVersion(listing(), changed, { now, admissionCheck: () => { throw new ValidationError("SYNTHETIC_PRIVATE_CALLBACK"); } });
    assert(Either.isRight(rejected));
    assert.equal(rejected.right.sub_reason, "admission_metadata_changed");
    assert(!JSON.stringify(rejected.right).includes("PRIVATE"));
  }

  const unexpectedCallback = checkSourceVersion(listing(), changed, { now, admissionCheck: () => { throw new Error("SYNTHETIC_PRIVATE_CALLBACK"); } });
  assert(Either.isLeft(unexpectedCallback));
  assert.equal(unexpectedCallback.left.code, "source_text_fetch_failed");
  assert.equal(Either.getOrThrow(checkSourceVersion(listing(), changed, { now, admissionCheck: () => null })).sub_reason, "admission_metadata_changed");
  assert.equal(Either.getOrThrow(checkSourceVersion(expiring, detail(newer), { now, admissionCheck: () => ({ status: "inside", reason: "ok" }) })).sub_reason, "admission_metadata_changed");
  const invalidStored = checkSourceVersion(listing({ row: { ...row, locations: "not-json" } }), detail(), { now });
  assert(Either.isLeft(invalidStored));
  assert.equal(invalidStored.left.code, "source_text_fetch_failed");
  assert.equal(check(detail(newer), listing({ row: { ...row, locations: "not-json" } })).sub_reason, "admission_metadata_changed");
  assert.equal(check(detail(), listing({ detailEvidence: { saved_changed: version, detail_changed: 1n }, savedDetailChanged: null })).sub_reason, "detail_mismatch");
  assert.equal(check(detail(), listing({ row: { ...row, locations: '{"Oslo":1}' } })).would_review, true);
  assert.equal(check(detail(version, { occupationCategories: [{ level1: 1n }] })).sub_reason, "detail_mismatch");
}

const workplaces = [{ municipal: "Oslo", address: "Synthetic Road 1", postalCode: "1234", country: "NORGE" }];

function boundListing(): SourceListing {
  const points = "[[60.0, 10.0]]";
  const binding = workplaceBinding({ digest: fingerprintWorkLocations({ workLocations: workplaces }), pointsJson: points, uuid: id, sourceVersion: version, detailChanged: version, detailSavedChanged: version, incomplete: false });
  const provenance = JSON.stringify({ provider: SUPPORTED_PROVIDER, method: SUPPORTED_METHOD, source_version: version, retrieved_at: version, provider_stedfestingverifisert: [true], workplace_fingerprint: binding });
  const verified = verifyWorkplaceEvidence({ provenance, uuid: id, sourceVersion: version, versionChanged: version, incomplete: 0, pointsJson: points, currentDetailEvidence: { saved_changed: version, detail_changed: version } });
  assert(Option.isSome(verified));

  return listing({ hasLocationPoints: true, locationEvidence: { points, incomplete: 0, provenance }, versionChanged: version, geographyEvidenceDigest: verified.value.geography_digest });
}

function bindingCases() {
  const saved = boundListing();
  const fresh = detail(newer, { workLocations: [{ ...workplaces[0], address: "  SYNTHETIC  ROAD 1 " }] });
  assert.equal(check(fresh, saved).would_review, true);

  for (const changed of [[], [...workplaces, ...workplaces], [{ ...workplaces[0], address: "Other Road 2" }], [{ ...workplaces[0], country: "Sverige" }]]) {
    assert.equal(check(detail(newer, { workLocations: changed }), saved).sub_reason, "location_evidence_stale");
  }

  for (const changes of [
    { geographyEvidenceDigest: "old" }, { versionChanged: "old" }, { detailEvidence: null },
    { detailEvidence: { saved_changed: version, detail_changed: newer } },
    { locationEvidence: { ...saved.locationEvidence, points: "[[62.0, 10.0]]" } },
    { locationEvidence: { ...saved.locationEvidence, incomplete: 1 } },
    { locationEvidence: { ...saved.locationEvidence, provenance: "bad" } },
  ]) assert.equal(check(fresh, { ...saved, ...changes }).sub_reason, "location_evidence_stale");
  assert.equal(check(detail(), { ...saved, geographyEvidenceDigest: "old" }).would_review, true);
  assert.equal(check(detail(newer), listing({ hasLocationPoints: null })).sub_reason, "location_evidence_stale");
  const legacy = listing({ savedDetailChanged: null, detailEvidence: null });
  assert.equal(check(detail("2026-10-19T09:00:01Z"), legacy).would_review, true);
}

async function fetchCases() {
  const directory = mkdtempSync(join(tmpdir(), "pulse-review-text-"));
  const path = join(directory, "source.sqlite3");
  const candidate = { id, version };
  const manifest = { candidates: [candidate] };
  const replay = (body: SourceObject | null = detail()) => NavClientReplay([{ url: "/api/v1/feedentry/" + id, kind: "detail", body }]);
  const run = (options: Partial<Parameters<typeof fetchCurrentAdTexts>[0]> = {}, replies = replay()) => Effect.runPromise(fetchCurrentAdTexts({ databasePath: path, manifest, candidates: [candidate], ...options }).pipe(Effect.provide(replies.layer), Effect.provide(BunContext.layer), Effect.either));

  const code = async (options: Partial<Parameters<typeof fetchCurrentAdTexts>[0]>, expected: string) => {
    const result = await run(options);
    assert(Either.isLeft(result)); assert.equal(result.left.code, expected);
  };

  try {
    await code({}, "source_text_fetch_failed");
    assert.equal(existsSync(path), false);
    const db = new Database(path);
    db.exec("CREATE TABLE ads(uuid TEXT PRIMARY KEY, changed TEXT, title TEXT, employer TEXT, locations TEXT, expires TEXT); CREATE TABLE versions(uuid TEXT PRIMARY KEY, changed TEXT); CREATE TABLE ad_detail_versions(uuid TEXT PRIMARY KEY, saved_changed TEXT, detail_changed TEXT)");
    db.query("INSERT INTO ads VALUES (?,?,?,?,?,?)").run(id, version, "Analyst", "Example", '["Oslo"]', null);
    db.query("INSERT INTO versions VALUES (?,?)").run(id, version);
    db.query("INSERT INTO ad_detail_versions VALUES (?,?,?)").run(id, version, version);
    db.close();
    const before = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    const result = await run();
    assert(Either.isRight(result));
    assert.equal(result.right.request_count, 1);
    assert.equal(result.right.available[0]?.text, "Text.");
    assert.equal(result.right.available[0]?.detail_changed, version);
    assert.equal(result.right.available[0]?.fingerprint, hash("Text."));
    assert.deepEqual(readFileSync(path), before); assert.equal(statSync(path).mtimeMs, mtime);
    await code({ candidates: Array.from({ length: 21 }, () => candidate) }, "full_text_batch_exceeds_candidate_limit");
    await code({ manifest: {} }, "source_manifest_invalid");
    await code({ manifest: { candidates: [candidate, candidate] } }, "source_manifest_invalid");
    await code({ candidates: [candidate, candidate] }, "candidate_batch_invalid");
    await code({ candidates: [null] }, "candidate_batch_invalid");
    await code({ candidates: [{ ...candidate, version: "other" }] }, "candidate_not_in_source_manifest");
    await code({ manifest: { candidates: [{ id: "bad", version }] }, candidates: [{ id: "bad", version }] }, "invalid_candidate_identity");
    const empty = await run({ databasePath: join(directory, "absent"), manifest: {}, candidates: [] });
    assert(Either.isRight(empty)); assert.equal(empty.right.request_count, 0);
    let updates = new Database(path);
    updates.query("UPDATE ad_detail_versions SET saved_changed='old'").run(); updates.close();
    const noFetch = replay();
    const stale = await run({}, noFetch);
    assert(Either.isRight(stale)); assert.equal(stale.right.unavailable[0]?.reason, "source_version_changed"); assert.equal(noFetch.calls.length, 0);
    updates = new Database(path); updates.exec("DROP TABLE ad_detail_versions"); updates.close();
    const legacy = await run({}, replay(detail("2026-10-19T08:55:00Z")));
    assert(Either.isRight(legacy)); assert.equal(legacy.right.available.length, 1);
    const tooLarge = await run({}, replay(detail(version, { description: "é".repeat(10_001) })));
    assert(Either.isRight(tooLarge)); assert.equal(tooLarge.right.unavailable[0]?.reason, "source_text_too_large");
    const missing = await run({}, replay(null));
    assert(Either.isRight(missing)); assert.equal(missing.right.unavailable[0]?.sub_reason, "detail_missing");

    const failingSession: NavSession = { remaining: 21, requests: 0, details_remaining: 20, token: null, deadline: Infinity,
      get: () => {
        failingSession.requests++;

        return Effect.fail(new SourceError({ message: "synthetic outage", transient: true }));
      } };

    await code({ session: failingSession }, "source_temporary");
    const definiteSession: NavSession = { ...failingSession, get: () => Effect.fail(new SourceError({ message: "synthetic definite" })) };
    const definite = await run({ session: definiteSession });
    assert(Either.isRight(definite)); assert.equal(definite.right.unavailable[0]?.reason, "source_fetch_failed");

    const bound = boundListing();
    updates = new Database(path);
    updates.exec("CREATE TABLE ad_detail_versions(uuid TEXT PRIMARY KEY, saved_changed TEXT, detail_changed TEXT); CREATE TABLE ad_locations(uuid TEXT PRIMARY KEY, points TEXT, incomplete INTEGER, provenance TEXT); CREATE TABLE ad_occupations(uuid TEXT, scheme TEXT, level1 TEXT, level2 TEXT)");
    updates.query("INSERT INTO ad_detail_versions VALUES (?,?,?)").run(id, version, version);
    updates.query("INSERT INTO ad_locations VALUES (?,?,?,?)").run(id, String(bound.locationEvidence?.points), 0, String(bound.locationEvidence?.provenance));
    updates.query("INSERT INTO ad_occupations VALUES (?,?,?,?)").run(id, "occupationCategories", "IT", "Development");
    updates.query("INSERT INTO ad_occupations VALUES (?,?,?,?)").run(id, "unrelated", "Other", "Other");
    updates.close();
    const occupations = [{ level1: " IT ", level2: "Development" }];
    const hydrated = await run({ manifest: { candidates: [{ ...candidate, geography_evidence_digest: bound.geographyEvidenceDigest }] } }, replay(detail(newer, { workLocations: workplaces, occupationCategories: occupations })));
    assert(Either.isRight(hydrated)); assert.equal(hydrated.right.available.length, 1);
    assert.deepEqual(hydrated.right.available[0]?.snapshot.occupation_categories, ["IT / Development"]);
    const throwing = await run({ manifest: { candidates: [{ ...candidate, geography_evidence_digest: bound.geographyEvidenceDigest }] }, admissionCheck: () => { throw new TypeError("SYNTHETIC_PRIVATE_CALLBACK"); } }, replay(detail(newer, { workLocations: workplaces, occupationCategories: occupations })));
    assert(Either.isRight(throwing));
    assert.equal(throwing.right.unavailable[0]?.sub_reason, "admission_metadata_changed");
    assert(!JSON.stringify(throwing.right).includes("PRIVATE"));
    updates = new Database(path);
    updates.query("INSERT INTO ad_occupations VALUES (?,?,?,?)").run(id, "occupationCategories", "IT", null);
    updates.close();
    const corruptOccupation = replay();
    const corruptResult = await run({}, corruptOccupation);
    assert(Either.isLeft(corruptResult));
    assert.equal(corruptResult.left.code, "source_text_fetch_failed");
    assert.equal(corruptOccupation.calls.length, 0);
    updates = new Database(path); updates.exec("DELETE FROM ad_occupations WHERE level2 IS NULL"); updates.close();
    const staleDigest = await run({ manifest: { candidates: [{ ...candidate, geography_evidence_digest: "old" }] } }, replay(detail(newer, { workLocations: workplaces, occupationCategories: occupations })));
    assert(Either.isRight(staleDigest)); assert.equal(staleDigest.right.unavailable[0]?.sub_reason, "location_evidence_stale");
    updates = new Database(path);
    updates.exec("UPDATE ads SET locations='not-json'"); updates.close();
    await code({}, "source_text_fetch_failed");
    updates = new Database(path); updates.exec(`UPDATE ads SET locations='["Oslo"]'`); updates.close();

    const tracked: ReviewSourceReader = {
      hasDetailVersions: reviewSourceReader.hasDetailVersions,
      readCurrentAd: (sql, identity, include) => Effect.gen(function* () {
        const queryOnly = yield* sql<{ query_only: number }>`PRAGMA query_only`;
        assert.equal(queryOnly[0]?.query_only, 1);
        const evidence = yield* reviewSourceReader.readCurrentAd(sql, identity, include);
        // Concurrent commit cannot change version evidence in the pinned read snapshot.
        const writer = new Database(path);
        writer.exec("PRAGMA busy_timeout=1");
        assert.throws(() => writer.query("UPDATE versions SET changed='concurrent'").run());
        writer.close();

        return evidence;
      }),
    };

    const trackedResult = await run({ reader: tracked });
    assert(Either.isRight(trackedResult)); assert.equal(trackedResult.right.available.length, 1);
    assert.equal(existsSync(join(directory, ".source.sqlite3.writer.lock")), false);
    // WAL permits a real concurrent writer while both ads retain the original read view.
    updates = new Database(path); updates.exec("PRAGMA journal_mode=WAL");
    const secondId = "2f6b830b-16d7-40e4-920a-26f278eab31d";
    updates.query("INSERT INTO ads VALUES (?,?,?,?,?,?)").run(secondId, version, "Analyst", "Example", '["Oslo"]', null);
    updates.query("INSERT INTO versions VALUES (?,?)").run(secondId, version); updates.close();
    let reads = 0;

    const snapshotReader: ReviewSourceReader = {
      hasDetailVersions: reviewSourceReader.hasDetailVersions,
      readCurrentAd: (sql, identity, include) => Effect.gen(function* () {
        const evidence = yield* reviewSourceReader.readCurrentAd(sql, identity, include);
        reads++;

        if (reads === 1) {
          const writer = new Database(path);
          writer.query("UPDATE versions SET changed='concurrent' WHERE uuid=?").run(secondId);
          writer.close();
        }

        return evidence;
      }),
    };

    const second = { id: secondId, version };
    const twoManifest = { candidates: [candidate, second] };
    const secondDetail = { ...detail(), uuid: secondId, ad_content: { uuid: secondId, updated: version, title: "Analyst", employer: { name: "Example" }, workLocations: [{ municipal: "Oslo" }], expires: null, description: "Second." } };
    const twoReplies = NavClientReplay([{ url: "/api/v1/feedentry/" + id, kind: "detail", body: detail() }, { url: "/api/v1/feedentry/" + secondId, kind: "detail", body: secondDetail }]);
    const twoResult = await run({ manifest: twoManifest, candidates: [candidate, second], reader: snapshotReader }, twoReplies);
    assert(Either.isRight(twoResult)); assert.equal(twoResult.right.available.length, 2); assert.equal(reads, 2);
    updates = new Database(path); updates.exec("UPDATE versions SET changed='" + version + "'"); updates.close();
    let calls = 0;

    const lateOutage: NavSession = { ...failingSession, get: () => {
      calls++;

      return calls === 1 ? Effect.succeed([detail(), {}] as const) : Effect.fail(new SourceError({ message: "late synthetic outage", transient: true }));
    } };

    const outage = await run({ session: lateOutage, manifest: twoManifest, candidates: [candidate, second] });
    assert(Either.isLeft(outage)); assert.equal(outage.left.code, "source_temporary"); assert.equal(calls, 2);
    // Missing rows/version evidence are rejected before any NAV request.
    updates = new Database(path); updates.exec("DELETE FROM versions"); updates.close();
    const removed = replay();
    const absentVersion = await run({}, removed);
    assert(Either.isRight(absentVersion)); assert.equal(absentVersion.right.unavailable[0]?.reason, "source_version_changed"); assert.equal(removed.calls.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const group = process.argv[2];

if (group === "decision") decisionCases();
else if (group === "binding") bindingCases();
else if (group === "fetch") await fetchCases();
else throw new Error("Unknown test group");

console.log(`${group}: passed`);
