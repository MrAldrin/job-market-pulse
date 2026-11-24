import { readFile } from "node:fs/promises";
import { Either, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AdTextBatch } from "../../src/lib/contracts/source-review.ts";
import { checkTextBatch, checkTextBinding, normalizeListingIds, snapshotProvenance, validateOutputTokenCap, validateRunLimits } from "../../src/lib/server/judge/workflow-support.ts";

const recorded = async () => {
  const raw = JSON.parse(await readFile("tests/oracle/basic-run/judge/detail-request-00000000-0000-0000-0000-000000000001.json", "utf8"));

  return Schema.decodeUnknownSync(AdTextBatch, { onExcessProperty: "error" })(raw.result);
};

const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"];

describe("Judge workflow admission checks", () => {
  it("rejects overbound, fractional and nonfinite run limits before source work", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 120 }), fc.integer({ min: 1, max: 32 }), (candidates, calls) => {
      expect(Either.getOrThrow(validateRunLimits(candidates, calls))).toEqual({ maxCandidates: candidates, maxCalls: calls });
    }));

    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity, 121]) expect(Either.isLeft(validateRunLimits(invalid, 1))).toBe(true);

    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity, 33]) expect(Either.isLeft(validateRunLimits(1, invalid))).toBe(true);

    for (const invalid of [0, 15, 50_001, 16.5, Number.NaN]) expect(Either.isLeft(validateOutputTokenCap(invalid))).toBe(true);
    expect(Either.getOrThrow(validateOutputTokenCap(50_000))).toBe(50_000);
  });

  it("sorts exact UUID selectors and rejects duplicates without a fallback pool", () => {
    expect(Either.getOrThrow(normalizeListingIds([...ids].reverse(), 2))).toEqual(ids);
    const upper = "ABCDEF00-0000-0000-0000-000000000001";
    expect(Either.getOrThrow(normalizeListingIds([upper], 1))).toEqual([upper.toLowerCase()]);

    for (const invalid of [[], ["not-a-uuid"], [ids[0]!, ids[0]!]]) expect(Either.isLeft(normalizeListingIds(invalid, 2))).toBe(true);
    expect(Either.isLeft(normalizeListingIds(ids, 1))).toBe(true);
    expect(Either.getOrThrow(normalizeListingIds(null, 1))).toBeNull();
  });

  it("rechecks recorded text bytes and snapshot identity rather than trusting labels", async () => {
    const batch = await recorded();

    for (const ad of batch.available) {
      expect(Either.isRight(checkTextBinding(ad, ad.source_version))).toBe(true);
      expect(Either.isLeft(checkTextBinding({ ...ad, text: ad.text + "!" }, ad.source_version))).toBe(true);
      expect(Either.isLeft(checkTextBinding({ ...ad, snapshot: { ...ad.snapshot, title: "changed" } }, ad.source_version))).toBe(true);
      expect(Either.isLeft(checkTextBinding(ad, "2099-01-01T00:00:00+00:00"))).toBe(true);
    }
  });

  it("requires disjoint and complete text-batch identities and a bounded request count", async () => {
    const batch = await recorded();
    const wanted = batch.available.map((ad) => ad.listing_id);
    expect(Either.isRight(checkTextBatch(batch, wanted))).toBe(true);
    expect(Either.isLeft(checkTextBatch({ ...batch, request_count: wanted.length + 2 }, wanted))).toBe(true);
    expect(Either.isLeft(checkTextBatch({ ...batch, request_count: 1.5 }, wanted))).toBe(true);
    expect(Either.isLeft(checkTextBatch({ ...batch, available: batch.available.slice(1) }, wanted))).toBe(true);
    expect(Either.isLeft(checkTextBatch({ ...batch, unavailable: [{ listing_id: wanted[0]!, reason: "source_text_unavailable", sub_reason: "description_missing" }] }, wanted))).toBe(true);
  });

  it("retains explicit reviewed expiry and never includes ad text in durable provenance", async () => {
    const batch = await recorded();
    const envelopes = Either.getOrThrow(snapshotProvenance(new Map(batch.available.map((ad) => [ad.listing_id, ad]))));
    expect(envelopes).not.toBeNull();

    for (const ad of batch.available) {
      const serialized = envelopes?.[ad.listing_id];
      expect(serialized).not.toContain(ad.text);
      expect(JSON.parse(serialized!)).toEqual({ format_version: 1, snapshot_id: ad.snapshot_id, expires_at: ad.snapshot.expires_at, provenance: null });
    }
  });
});
