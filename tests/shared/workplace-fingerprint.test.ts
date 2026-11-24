import { Either, Option, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fingerprintWorkLocations, hasCurrentWorkplaceBinding, pointPayloadDigest, pointPayloadJson, SUPPORTED_METHOD, SUPPORTED_PROVIDER, validAddressText, validPostalCode, verifyWorkplaceEvidence, workplaceBinding } from "../../src/lib/server/shared/workplace-fingerprint.ts";
import { JsonObject, type JsonInput, parseJsonInput } from "../../src/lib/server/shared/json-input.ts";

const changed = "2026-10-19T10:00:00+00:00";
const id = "00000000-0000-0000-0000-000000000001";
const location = { address: "Invented Road 1", postalCode: "1234", country: "NORGE" };
const content = { workLocations: [location] };
const points = "[[60.01, 10.0]]";
const hash = "050699e295b6e36f8c5d9f532cdb81369249a243fede51355d1daadcfc65a9ed";
const binding = workplaceBinding({ digest: hash, pointsJson: points, uuid: id, sourceVersion: changed, detailChanged: changed, detailSavedChanged: changed, incomplete: false });
const provenance = { method: SUPPORTED_METHOD, provider: SUPPORTED_PROVIDER, provider_stedfestingverifisert: [true], retrieved_at: "2026-10-19T12:00:00+00:00", source_version: changed, workplace_fingerprint: binding };
const input = { provenance: JSON.stringify(provenance), uuid: id, sourceVersion: changed, versionChanged: changed, incomplete: false, pointsJson: points, currentDetailEvidence: { saved_changed: changed, detail_changed: changed }, currentDetailContent: content };

describe("privacy-minimized workplace identity", () => {
  it("matches independent frozen source provenance and manifest geography digests", () => {
    expect(fingerprintWorkLocations(content)).toBe(hash);
    expect(pointPayloadJson([[60.01, 10]])).toBe(points);
    expect(pointPayloadDigest(points)).toBe("f0d25c54e72ea97ec58cde4cac27129cfbaa207f741db0a964f565b54e2bf1b9");
    const verified = Option.getOrThrow(verifyWorkplaceEvidence(input));
    expect(verified.geography_digest).toBe("2841e318dfcbbac97752cbb177d45c08ae721e100b1dd3506ce6811043201ae5");
    expect(verified.workplace_digest).toBe(hash);
    expect(verified.points_digest).toBe(pointPayloadDigest(points));
    expect(verified.point_count).toBe(1);
    expect(JSON.stringify(verified)).not.toContain("Invented Road");
    expect(hasCurrentWorkplaceBinding(input)).toBe(true);
  });
  it("normalizes whitespace and case, but preserves punctuation, numbers, postcodes and multiplicity", () => {
    expect(fingerprintWorkLocations({ workLocations: [{ address: " invented   ROAD 1 ", postalCode: "1234", country: "NO", ignored: "private" }] })).toBe(hash);

    for (const row of [{ address: "Invented Road 2", postalCode: "1234", country: "NORGE" }, { address: "Invented Road 1.", postalCode: "1234", country: "NORGE" }, { address: "Invented Road 1", postalCode: "9999", country: "NORGE" }]) expect(fingerprintWorkLocations({ workLocations: [row] })).not.toBe(hash);

    expect(fingerprintWorkLocations({ workLocations: [...content.workLocations, ...content.workLocations] })).not.toBe(hash);
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 15 }), (numbers) => {
      const locations = numbers.map((n) => ({ address: `Synthetic Road ${n}`, postalCode: "1234", country: "NO" }));
      expect(fingerprintWorkLocations({ workLocations: locations })).toBe(fingerprintWorkLocations({ workLocations: locations.toReversed() }));
    }));
  });
  it("keeps omitted, null, empty, invalid, missing-field and numeric-token states distinct", () => {
    const variants: Readonly<Record<string, JsonInput>>[] = [{}, { workLocations: null }, { workLocations: [] }, { workLocations: {} }, { workLocations: [null] }, { workLocations: [{}] }, { workLocations: [{ address: null }] }, { workLocations: [{ address: "" }] }, { workLocations: [{ address: 1n }] }, { workLocations: [{ address: 1 }] }];
    expect(new Set(variants.map(fingerprintWorkLocations)).size).toBe(variants.length);
    expect(fingerprintWorkLocations({ workLocations: [{ country: null }] })).not.toBe(fingerprintWorkLocations({ workLocations: [{ country: "Sverige" }] }));
    expect(fingerprintWorkLocations({ workLocations: [{ address: Number.NaN }] })).not.toBe(fingerprintWorkLocations({ workLocations: [{ address: Number.POSITIVE_INFINITY }] }));
    expect(pointPayloadJson([[-0, 1e-7]])).toBe("[[-0.0, 1e-07]]");
  });
  it("uses exact input guards including Unicode decimal address numbers and ASCII postcodes", () => {
    expect(validAddressText("Invented road ١")).toBe(true);

    for (const text of ["No number", "Road\n1", "x".repeat(300) + "1"]) expect(validAddressText(text)).toBe(false);

    expect(validPostalCode("0123")).toBe(true);

    for (const value of ["１２３４", "123", "1234\n", " 1234", 1234n]) expect(validPostalCode(value)).toBe(false);
  });
  it.each(["[]", "null", "{}", "[[true,10]]", "[[91,10]]", "[[60,181]]", "[[60]]", "[[60,10,20]]", "[[1e400,10]]", "[[" + "9".repeat(400) + ",10]]"])("refuses invalid or changed point payload %s", (pointsJson) => {
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, pointsJson }))).toBe(true);
  });
  it("refuses stale or wrong identity, missing evidence, incomplete inputs and altered content", () => {
    for (const patch of [{ uuid: "invalid" }, { uuid: "00000000-0000-0000-0000-000000000002" }, { sourceVersion: "2026-10-19T10:00:00Z" }, { sourceVersion: "0000-10-19T10:00:00+00:00" }, { versionChanged: null }, { incomplete: true }, { incomplete: 1 }]) expect(Option.isNone(verifyWorkplaceEvidence({ ...input, ...patch }))).toBe(true);

    const { currentDetailEvidence: _evidence, ...withoutEvidence } = input;
    expect(Option.isNone(verifyWorkplaceEvidence(withoutEvidence))).toBe(true);
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, currentDetailEvidence: { saved_changed: changed, detail_changed: "wrong" } }))).toBe(true);

    for (const value of [{ workLocations: [] }, { workLocations: [location, location] }, { workLocations: [{ address: "Different Road 1", postalCode: "1234", country: "NO" }] }]) expect(Option.isNone(verifyWorkplaceEvidence({ ...input, currentDetailContent: value }))).toBe(true);
  });
  it("refuses unsupported versions, wrong numeric tokens, extra keys and altered provider data", () => {
    for (const patch of [{ version: 2 }, { version: true }, { point_digest_version: 2 }, { points_sha256: "a".repeat(64) }, { incomplete: 0 }, { detail_changed: "2026-10-19T10:00:00.000000+00:00" }, { unexpected: true }]) {
      const text = JSON.stringify({ ...provenance, workplace_fingerprint: { ...binding, ...patch } });
      expect(Option.isNone(verifyWorkplaceEvidence({ ...input, provenance: text }))).toBe(true);
    }

    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, provenance: input.provenance.replace('"version":1', '"version":1.0') }))).toBe(true);

    for (const patch of [{ method: "different" }, { provider: "https://untrusted.invalid" }, { retrieved_at: "2026-02-30T12:00:00+00:00" }, { provider_stedfestingverifisert: [1] }, { provider_stedfestingverifisert: [] }, { unexpected: true }]) expect(Option.isNone(verifyWorkplaceEvidence({ ...input, provenance: JSON.stringify({ ...provenance, ...patch }) }))).toBe(true);
  });
  it("does not attest workplace fields inherited from an own __proto__ data key", () => {
    const content = Schema.decodeUnknownSync(JsonObject)(Either.getOrThrow(parseJsonInput('{"workLocations":[{"__proto__":{"address":"Invented Road 1","postalCode":"1234","country":"NORGE"}}]}')));
    const forged = { ...binding, sha256: fingerprintWorkLocations(content) };
    expect(forged.sha256).toBe(fingerprintWorkLocations({ workLocations: [{}] }));
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, currentDetailContent: content, provenance: JSON.stringify({ ...provenance, workplace_fingerprint: forged }) }))).toBe(true);
    expect(Object.hasOwn(Object.prototype, "address")).toBe(false);
  });
  it("allows only the exact fallback evidence alternative", () => {
    const fallback = { ...binding, detail_saved_changed: null, detail_version_source: "source_changed_fallback" };
    const text = JSON.stringify({ ...provenance, workplace_fingerprint: fallback });
    const { currentDetailEvidence: _evidence, ...rest } = input;
    expect(Option.isSome(verifyWorkplaceEvidence({ ...rest, provenance: text }))).toBe(true);
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, provenance: text }))).toBe(true);
  });
  it("fails closed on excessively deep untrusted JSON instead of throwing", () => {
    const nested = "[".repeat(2000) + "0" + "]".repeat(2000);
    expect(() => parseJsonInput(nested)).not.toThrow();
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, provenance: nested }))).toBe(true);
    expect(Option.isNone(verifyWorkplaceEvidence({ ...input, pointsJson: nested }))).toBe(true);
    expect(Either.isLeft(parseJsonInput("not json"))).toBe(true);
  });
});
