import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { disclosureText, reviewerEvent } from "../../src/lib/server/judge/run-information.ts";
import type { Reviewer } from "../../src/lib/server/judge/reviewers.ts";

const reviewer: Reviewer = { id: "synthetic-pi", harness: "pi", provider: "openai", model: "synthetic-pi-model", effort: "medium", batch_size: 5, max_budget_usd: null, timeout_seconds: 1800 };
const options = { profileId: "synthetic", host: "invented-host", maxOutputTokens: 1000, fullReviewBatchSize: 5 };

describe("review run information", () => {
  it("reports configured models and bounds without an allow-list or consent offer", () => {
    expect(reviewerEvent(reviewer)).toEqual({ id: "synthetic-pi", harness: "pi", provider: "openai", model: "synthetic-pi-model", effort: "medium", batch_size: 5 });
    const text = Either.getOrThrow(disclosureText(reviewer, options));
    expect(text).toContain("Calling machine: invented-host.");
    expect(text).toContain("144 full-ad requests (214 total)");
    expect(text).toContain("There is no dollar cap or per-run approval prompt.");
    expect(text).toContain("A subscription is not API access.");
    expect(text).toContain("Listing selection: dynamic.");
  });

  it("keeps read-only source disclosure and sorted exact listing selection explicit", () => {
    const text = Either.getOrThrow(disclosureText(reviewer, { ...options, readOnlySource: true, fullReviewBatchSize: 10,
      listingIds: ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000001"] }));

    expect(text).toContain("Read-only source checks. Up to 132 full-ad requests.");
    expect(text).toContain("Listing selection: 00000000-0000-0000-0000-000000000001, 00000000-0000-0000-0000-000000000002.");
  });

  it("rejects malformed host and invalid batch bounds instead of guessing", () => {
    expect(Either.isLeft(disclosureText(reviewer, { ...options, host: "host\nprivate" }))).toBe(true);
    expect(Either.isLeft(disclosureText(reviewer, { ...options, fullReviewBatchSize: 11 }))).toBe(true);
  });
});
