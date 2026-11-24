import { Either, Schema } from "effect";
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { Digest, ProfileId, RequestProvenance, RunContext } from "../../src/lib/contracts/judge-state.ts";
import { batchFingerprint, finishedRunStatus, instant, normalizeIdentity, utcText } from "../../src/lib/server/judge/core.ts";

const id = "00000000-0000-0000-0000-000000000001";

const input = {
  listing_id: id, source_version: "2026-01-01T00:00:00Z", input_fingerprint: "a".repeat(64),
  source_text_fingerprint: null, upstream_result_id: null, snapshot_provenance_json: null,
};

describe("private Judge rules", () => {
  test("UUID aliases normalize before uniqueness and saved identity checks", () => {
    for (const value of [id, "{00000000000000000000000000000001}", `urn:uuid:${id}`, `{{${id}}}`]) {
      expect(normalizeIdentity(value)).toEqual(Either.right(id));
    }

    for (const value of [id + "\n", "missing", id.slice(1), id.replace("1", "g")]) {
      expect(Either.isLeft(normalizeIdentity(value))).toBe(true);
    }
  });

  test("trailing newlines cannot bypass digest and profile identity boundaries", () => {
    expect(Schema.is(Digest)("a".repeat(64) + "\n")).toBe(false);
    expect(Schema.is(ProfileId)("alice\n")).toBe(false);
  });

  test("raw integer-only run and usage fields do not accept float tokens or booleans", () => {
    const context = {
      coverage_id: "a".repeat(64), source_checked_at: "2026-01-01T00:00:00Z",
      profile_fingerprint: "b".repeat(64), preferences_fingerprint: "c".repeat(64),
      rules_fingerprint: "d".repeat(64), scoring_version: "v1", candidate_count: 1n,
      full_review_batch_size: 5n,
    };

    const decode = Schema.decodeUnknownEither(RunContext, { onExcessProperty: "error" });

    expect(Either.isRight(decode(context))).toBe(true);

    for (const value of [1, true, 0n, 11n]) {
      expect(Either.isLeft(decode({ ...context, full_review_batch_size: value }))).toBe(true);
    }

    const provenance = {
      provider_label: null, model_label: null, reasoning_level: null, call_count: 1n,
      request_bytes: null, response_bytes: null, input_tokens: null, output_tokens: null,
    };

    expect(Either.isLeft(Schema.decodeUnknownEither(RequestProvenance)({ ...provenance, input_tokens: 1.0 }))).toBe(true);
  });

  test("batch identity ignores input order but never schema, prompt or upstream identity", () => {
    const second = { ...input, listing_id: "00000000-0000-0000-0000-000000000002" };
    const baseline = batchFingerprint("title_screen", "s1", "p1", [input, second]);

    expect(batchFingerprint("title_screen", "s1", "p1", [second, input])).toBe(baseline);
    expect(batchFingerprint("title_screen", "s2", "p1", [input, second])).not.toBe(baseline);
    expect(batchFingerprint("title_screen", "s1", "p2", [input, second])).not.toBe(baseline);
    expect(batchFingerprint("title_screen", "s1", "p1", [{ ...input, upstream_result_id: second.listing_id }, second])).not.toBe(baseline);
    expect(batchFingerprint("title_screen", "s1", "p1", [{ ...input, snapshot_provenance_json: "{}" }, second])).toBe(baseline);
  });

  test("run SQL clocks use UTC and six fractional digits", () => {
    const now = Either.getOrThrow(instant("2026-10-01T12:00:00.123+02:00"));
    expect(utcText(now)).toEqual(Either.right("2026-10-01T10:00:00.123000+00:00"));
  });

  test("unfinished or mixed failures cannot masquerade as completed coverage", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 120 }), (completed, screenedOut) => {
      expect(finishedRunStatus(completed + screenedOut, completed, screenedOut, [])).toBe("completed");
    }));
    expect(finishedRunStatus(0, 0, 0, [])).toBe("completed");
    expect(finishedRunStatus(3, 1, 2, ["completed"])).toBe("completed");
    expect(finishedRunStatus(1, 0, 0, ["blocked", "blocked"])).toBe("blocked");
    expect(finishedRunStatus(1, 0, 0, ["failed", "failed"])).toBe("failed");

    for (const attempts of [[], ["unknown"], ["pending"], ["failed", "blocked"]] as const) {
      expect(finishedRunStatus(1, 0, 0, attempts)).toBe("partial");
    }
  });
});
