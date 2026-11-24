import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { selectShortlist, shortlistRule, type SavedCandidate } from "../../src/lib/server/select/shortlist-select.ts";

const candidate = (listing_id: string, fit: string, lifecycle_status = "saved_source_unconfirmed"): SavedCandidate => ({
  listing_id, lifecycle_status, full_review: { fit }, title: "Title", employer: "Employer",
  application_due: null, expires_at: null, source_version: null,
});

describe("saved shortlist selection", () => {
  it("sorts by fit, newest aware time, then codepoint ID; missing and naive times last", () => {
    const items = [candidate("strong-new", "strong"), candidate("exceptional-old", "exceptional"), candidate("strong-missing", "strong"), candidate("strong-naive", "strong"), candidate("strong-tie", "strong"), candidate("exceptional-new", "exceptional")];
    const dates = { "strong-new": "2026-11-05T11:00:00+01:00", "strong-tie": "2026-11-05T10:00:00Z", "strong-naive": "2026-11-05T12:00:00", "exceptional-new": "2026-11-02T10:00:00Z", "exceptional-old": "2026-11-01T10:00:00Z" };
    expect(selectShortlist(items, dates, "active").map((item) => item.listing_id)).toEqual(["exceptional-new", "exceptional-old", "strong-new", "strong-tie", "strong-missing", "strong-naive"]);
    expect(items[0]?.listing_id).toBe("strong-new");
  });

  it.each([
    ["9999-12-31", "000015", "000016", ["z", "a"]],
    ["0001-01-01", "000003", "000004", ["z", "a"]],
    // Both values round to the same Python float; do not order by exact bigint.
    ["9999-12-31", "000014", "000015", ["a", "z"]],
    ["0001-01-01", "000002", "000003", ["a", "z"]],
    ["1970-01-01", "000000", "000001", ["z", "a"]],
  ])("preserves timestamp float rounding and ties at %s (%s/%s)", (date, earlier, later, expected) => {
    const dates = { a: `${date}T00:00:00.${earlier}+00:00`, z: `${date}T00:00:00.${later}+00:00` };

    expect(selectShortlist([candidate("a", "exceptional"), candidate("z", "exceptional")], dates, "active").map((item) => item.listing_id)).toEqual(expected);
  });

  it("excludes closed lifecycles and respects modes without excluding unconfirmed expiry", () => {
    const items = [candidate("e", "exceptional"), candidate("s", "strong", "expiry_unverified"), candidate("closed", "exceptional", "source_expired"), candidate("weak", "possible")];
    expect(selectShortlist(items, {}, "active").map((item) => item.listing_id)).toEqual(["e", "s"]);
    expect(selectShortlist(items, {}, "passive").map((item) => item.listing_id)).toEqual(["e"]);
    expect(shortlistRule("active")).toBe("exceptional and strong; open; exceptional first, then newest first");
  });

  it("never fills a quota when no assessment qualifies", () => {
    fc.assert(fc.property(fc.array(fc.record({
      id: fc.uuid({ version: 4 }), fit: fc.constantFrom("possible", "poor"),
      lifecycle: fc.constantFrom("saved_source_unconfirmed", "expiry_unverified", "source_expired"),
    }), { maxLength: 30 }), (rows) => {
      expect(selectShortlist(rows.map((row) => candidate(row.id, row.fit, row.lifecycle)), {}, "active")).toEqual([]);
    }));
  });
});
