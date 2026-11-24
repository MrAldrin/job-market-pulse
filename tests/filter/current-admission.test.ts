import { Either, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeCurrentAdmission, occupationPairsFromContent, type FilterSourceListing } from "../../src/lib/server/filter/current-admission.ts";
import { buildManifest, manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { NEUTRAL_SCREEN } from "../../src/lib/server/filter/screen-context.ts";
import { fingerprintWorkLocations, pointPayloadJson, SUPPORTED_METHOD, SUPPORTED_PROVIDER, verifyWorkplaceEvidence, workplaceBinding } from "../../src/lib/server/shared/workplace-fingerprint.ts";
import { pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { filterSettings, uuid, version } from "./fixtures.ts";

const content = { title: "General role", employer: { name: "Example" }, workLocations: [{ municipal: "Near", country: "Norge", address: "Invented 1", postalCode: "1234" }], occupationCategories: [{ level1: "IT", level2: null }] };
const candidate = { id: uuid, version, title: content.title, employer: content.employer.name, locations: ["Near"], url: "https://arbeidsplassen.nav.no/stillinger/stilling/" + uuid, expires_at: null, detail_missing: false, geography: "inside" as const, geography_reason: "Synthetic evidence", occupation_categories: ["IT"] };
const manifest = () => Either.getOrThrow(buildManifest(Either.getOrThrow(manifestCommon("fixture", filterSettings())), [candidate], version));
const listing: FilterSourceListing = { row: { uuid, changed: version }, hasLocationPoints: false, detailEvidence: null, locationEvidence: null, versionChanged: version, geographyEvidenceDigest: null };
const near = { kommunenummer: "1", name: "Near", hull: [[0, 0] as const] };
const areas = new Map([["near", near]]);

const callback = () => {
  const result = makeCurrentAdmission(filterSettings(), manifest(), areas);

  if (result === null) throw new Error("Invalid synthetic fixture");

  return result;
};

describe("current refreshed admission", () => {
  it("fails closed on missing/version/context changes and keeps the hard40km ceiling", () => {
    expect(makeCurrentAdmission(filterSettings(), null, areas)).toBeNull();
    const admits = callback();

    expect(admits(content, listing)?.status).toBe("inside");
    expect(admits(content, { ...listing, row: { uuid, changed: "newer" } })).toBeNull();
    expect(admits(content, { ...listing, row: { uuid: "other", changed: version } })).toBeNull();
    expect(admits({ ...content, occupationCategories: [] }, listing)).toBeNull();
    const changed = makeCurrentAdmission({ ...filterSettings(), preference_fingerprint: "d".repeat(64) }, manifest(), areas);

    expect(changed?.(content, listing)).toBeNull();
    const far = new Map([["near", { ...near, hull: [[0.4, 0] as const] }]]);

    expect(makeCurrentAdmission(filterSettings(), manifest(), far)?.(content, listing)).toBeNull();
  });

  it("remains neutral with invented Profile Screen rules unless the override is explicitly selected and bound", () => {
    const settings = { ...filterSettings(), screen: { academic: ["General"] }, rules_fingerprint: "c".repeat(64) };
    const explicit = { rules_fingerprint: settings.rules_fingerprint, excludeTitle: () => "synthetic exclusion" };

    expect(makeCurrentAdmission(settings, manifest(), areas)?.(content, listing)?.status).toBe("inside");
    expect(makeCurrentAdmission(settings, manifest(), areas, explicit)?.(content, listing)).toBeNull();
    const selected = Either.getOrThrow(buildManifest(Either.getOrThrow(manifestCommon("fixture", settings, explicit)), [candidate], version));

    expect(makeCurrentAdmission(settings, selected, areas, explicit)?.(content, listing)).toBeNull();
    expect(makeCurrentAdmission(settings, selected, areas, NEUTRAL_SCREEN)?.(content, listing)).toBeNull();
  });

  it("rechecks raw points/provenance/current detail binding rather than trusting a digest shorthand", () => {
    const pointsJson = pointPayloadJson([[0, 0]]);

    const provenance = pythonJson({ provider: SUPPORTED_PROVIDER, method: SUPPORTED_METHOD, source_version: version, retrieved_at: version,
      provider_stedfestingverifisert: [true], workplace_fingerprint: workplaceBinding({ digest: fingerprintWorkLocations(content), pointsJson, uuid, sourceVersion: version, detailChanged: version, detailSavedChanged: null, incomplete: false }) });

    const verified = Option.getOrThrow(verifyWorkplaceEvidence({ uuid, sourceVersion: version, versionChanged: version, provenance, pointsJson, incomplete: 0, currentDetailContent: content }));
    const bound: FilterSourceListing = { ...listing, hasLocationPoints: true, geographyEvidenceDigest: verified.geography_digest, locationEvidence: { points: pointsJson, incomplete: 0, provenance } };
    const admits = callback();

    expect(admits(content, bound)?.point_based).toBe(true);
    expect(admits(content, { ...bound, locationEvidence: { points: pointsJson, incomplete: 1, provenance } })).toBeNull();
    expect(admits(content, { ...bound, geographyEvidenceDigest: "a".repeat(64) })).toBeNull();
    expect(admits(content, { ...bound, locationEvidence: null })).toBeNull();
    expect(admits({ ...content, workLocations: [{ ...content.workLocations[0], address: "Changed 2" }] }, bound)).toBeNull();
  });

  it("rejects malformed occupation evidence without letting title interests rescue it", () => {
    expect(occupationPairsFromContent({ occupationCategories: [{ level1: " IT ", level2: " A  B " }, { level1: "IT", level2: "A B" }, { level1: "" }] })).toEqual([["IT", "A B"]]);
    expect(occupationPairsFromContent({ occupationCategories: [{ level1: 1 }] })).toBeNull();
    expect(occupationPairsFromContent({ occupationCategories: {} })).toBeNull();
    expect(occupationPairsFromContent({ occupationCategories: null })).toEqual([]);
    expect(callback()({ ...content, title: "Python developer", occupationCategories: [{ level1: "Unrelated", level2: null }] }, listing)).toBeNull();
  });
});
