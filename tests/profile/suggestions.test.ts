import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { applySuggestions, decodeSuggestions } from "../../src/lib/server/profile/suggestions.ts";

const filters = '[geography]\nradius_km = 30\n[jobs]\nexcluded_employers = ["Straße"]\n';

describe("suggestions", () => {
  it("keeps original bytes for duplicates and preserves existing order", () => {
    expect(applySuggestions(filters, { excluded_employers: [{ value: "STRASSE", reason: "same" }] })).toEqual(Either.right(filters));
    const result = applySuggestions(filters, { excluded_employers: [{ value: "Other", reason: "stated" }] });
    expect(Either.isRight(result)).toBe(true);

    if (Either.isRight(result)) expect(result.right).toContain('"Straße", "Other"');
  });
  it("rejects changes to preferred terms, geography and unknown keys", () => {
    for (const input of ['preferred_terms = []', 'geography = {}', 'radius_km = 5']) expect(Either.isLeft(decodeSuggestions(input))).toBe(true);
    expect(Either.isLeft(applySuggestions('[jobs]\npreferred_terms = ["x"]', {}))).toBe(true);
  });
  it("normalizes padded legacy mode and reasons without applying mode", () => {
    const source = '[mode]\nvalue = " active "\nreason = " Explicit request "\n';
    const decoded = decodeSuggestions(source);
    expect(Either.isRight(decoded)).toBe(true);

    if (Either.isRight(decoded)) {
      expect(decoded.right.mode).toEqual({ value: "active", reason: "Explicit request" });
      expect(applySuggestions(filters, decoded.right)).toEqual(Either.right(filters));
    }
  });
  it("bounds list size and printable value and reason", () => {
    for (const items of [Array.from({ length: 101 }, () => ({ value: "x", reason: "r" })), [{ value: "x".repeat(501), reason: "r" }], [{ value: "x\ny", reason: "r" }]]) expect(Either.isLeft(applySuggestions(filters, { excluded_employers: items }))).toBe(true);
  });
});
