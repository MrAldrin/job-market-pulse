import { readFileSync } from "node:fs";
import { Either } from "effect";
import fc from "fast-check";
import { expect, it } from "vitest";
import { decodeSnapshotBytes, decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import { snapshotV2 } from "../../src/lib/server/snapshot/market-history.ts";
import type { MarketHistoryEntry } from "../../src/lib/contracts/market.ts";

const bytes = readFileSync("contracts/fixtures/snapshot.example.json");
const base = Either.getOrThrow(decodeSnapshotBytes(bytes));

const point: MarketHistoryEntry = {
  info: { id: 99, label: "detail-week-2026-W03", period_start: "2026-01-12", period_end: "2026-01-18", source: "private/source/path", sampled: false, ad_count: 8, taxonomy_version: "roles-1", created_at: "2026-01-15T08:00:00+00:00", basis: "titles+text" },
  counts: { families: { data: 3, other: 5 }, terms: { sql: 2 }, tech_terms: { sql: 2 } },
  unknown_words: { private: 4 }, words_complete: true, origin: "recorded",
  metadata: { profile_id: "demo", series: "detailed", capture_week: "week-2026-W03", timezone: "Europe/Oslo", membership: "current_unexpired_stock", classifier_engine: "native_js_known_ab_v1", filter_fingerprint: "a".repeat(64), population: 8, text_coverage: 3, occupation_coverage: 5 },
};

it("keeps v1 exact while explicit v2 exposes truthful current-stock counts without store internals", () => {
  const v2 = Either.getOrThrow(snapshotV2(base, [point]));
  expect(v2.schema_version).toBe(2);
  expect(v2.market_history?.[0]?.metadata).toMatchObject({ population: 8, text_coverage: 3, occupation_coverage: 5 });
  const encoded = new TextEncoder().encode(JSON.stringify(v2));
  expect(Either.isRight(decodeSnapshotDocumentBytes(encoded))).toBe(true);
  expect(Either.isLeft(decodeSnapshotBytes(encoded))).toBe(true);
  const wire = JSON.stringify(v2.market_history);
  expect(wire).not.toContain("private");
  expect(wire).not.toContain('"id"');
  expect(wire).not.toContain("coverage\":\"closed");
  expect(Either.getOrThrow(decodeSnapshotDocumentBytes(bytes)).schema_version).toBe(1);
  expect(Either.getOrThrow(snapshotV2(base, null)).market_history).toBeNull();
});

it("preserves independent X/Y and K/Y coverage without treating title fallback as reviewed text", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }), (text, occupations) => {
    const metadata = { ...point.metadata!, text_coverage: text, occupation_coverage: occupations };
    const v2 = Either.getOrThrow(snapshotV2(base, [{ ...point, metadata }]));

    expect(v2.market_history?.[0]?.metadata).toEqual(metadata);
  }), { numRuns: 30 });
});

it("rejects false coverage, foreign profile metadata and unknown v2 fields instead of silently expanding history", () => {
  expect(Either.isLeft(snapshotV2(base, [{ ...point, metadata: { ...point.metadata!, text_coverage: 9 } }]))).toBe(true);
  expect(Either.isLeft(snapshotV2(base, [{ ...point, metadata: { ...point.metadata!, profile_id: "other" } }]))).toBe(true);
  const v2 = Either.getOrThrow(snapshotV2(base, [point]));
  const encoded = new TextEncoder().encode(JSON.stringify({ ...v2, future_wire: true }));
  expect(Either.isLeft(decodeSnapshotDocumentBytes(encoded))).toBe(true);
});
