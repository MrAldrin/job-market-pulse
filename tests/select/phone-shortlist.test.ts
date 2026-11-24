import { createHash } from "node:crypto";
import { BunFileSystem } from "@effect/platform-bun";
import { comparePhoneBoundaries } from "../oracle/phone-shortlist.ts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { PhoneShortlist, PhoneShortlistLive, SavedReviewResource, SEEN_SCRIPT, renderShortlist, summaryExpiry, summaryText } from "../../src/lib/server/select/phone-shortlist.ts";
import { type SavedCandidate } from "../../src/lib/server/select/shortlist-select.ts";

const candidate = (listing_id: string, lifecycle_status = "open"): SavedCandidate => ({
  listing_id, lifecycle_status, full_review: { fit: "exceptional", reason: "<reason 'quoted'>" },
  title: "A & B", employer: '"Works"', application_due: null, expires_at: "2099-01-01T02:00:00+02:00", source_version: "v1",
});

const now = new Date("2026-10-19T12:00:00Z");

const runCapture = (verified: boolean) => Effect.runPromise(Effect.gen(function* () {
  const service = yield* PhoneShortlist;

  return yield* service.capture("invented", "active", now);
}).pipe(Effect.provide(PhoneShortlistLive.pipe(Layer.provide(Layer.succeed(SavedReviewResource, {
  read: Effect.succeed({ verified, listingIds: ["a", "b"], candidates: [candidate("b", "expiry_unverified"), candidate("a"), candidate("c")], firstFound: {} }),
}))))));

describe("phone shortlist", () => {
  it("independently replays all four saved-review shortlist HTML and full candidate JSON artifacts", async () => {
    const result = await Effect.runPromise(comparePhoneBoundaries.pipe(Effect.provide(BunFileSystem.layer)));

    expect(result).toHaveLength(4);
  });

  it("captures selected cards and sorted summaries, omitting unverified expiry summaries", async () => {
    const result = await runCapture(true);
    const html = new TextDecoder().decode(result.html);
    expect(html).toContain('data-job="a"');
    expect(html).toContain('data-job="b"');
    expect(html).not.toContain('data-job="c"');
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&lt;reason &#x27;quoted&#x27;&gt;");
    expect(html).toContain("Source status unconfirmed");
    expect(result.metadata).toEqual({ profile_id: "invented", jobs: [{ listing_id: "a", summary: {
      title: "A & B", employer: '"Works"', deadline: null, expires_at: "2099-01-01T00:00:00+00:00", source_status: "unknown", source_version: "v1", source_checked_at: null,
    } }] });
  });
  it("refuses an unverified funnel", async () => { await expect(runCapture(false)).rejects.toThrow("funnel"); });
  it("rejects controls, bidi and surrogates and counts Unicode scalars", () => {
    expect(summaryText("a\u202eb", 512)).toBeNull();
    expect(summaryText("\ud800", 512)).toBeNull();
    expect(summaryText("😀".repeat(512), 512)).not.toBeNull();
    expect(summaryText("😀".repeat(513), 512)).toBeNull();
    expect(summaryExpiry("2026-01-01T00:00:00")).toBeNull();
    expect(summaryExpiry("2026-01-01T12qZ")).toBeNull();
    expect(summaryExpiry("2026-01-01T123456123456Z")).toBeNull();
  });
  it("renders source-bound URLs and an empty state", () => {
    const html = new TextDecoder().decode(renderShortlist([candidate("a'&")], "p'", "passive", {}, now));
    expect(html).toContain('data-shortlist="p&#x27;"');
    expect(html).toContain('https://arbeidsplassen.nav.no/stillinger/stilling/a&#x27;&amp;');
    expect(new TextDecoder().decode(renderShortlist([], "p", "passive", {}, now))).toContain("No current recommendations yet");
    expect(createHash("sha256").update(SEEN_SCRIPT).digest("base64")).toBe("2nH/lyAAxXyC8tFRH4ZEEIoJllB7IbrSSRpQuOFGqyk=");
  });
});
