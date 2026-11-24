import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { displayReviewModel } from "../../src/lib/server/judge/rejudge.ts";
import { decodeModelSettings, modelSteps, piDeadlineSeconds } from "../../src/lib/server/judge/reviewers.ts";

const settings = (model = "synthetic/model", batch = "5") => modelSteps.map((step) => `[${step}]\nharness = "pi"\nmodel = "${model}"\neffort = "medium"\nbatch_size = ${batch}\n`).join("\n");

describe("installation reviewer settings", () => {
  it("omits model labels that are too long after joining provider and model", () => {
    const provider = "syntheticX";
    expect(displayReviewModel(provider, "m".repeat(89))).toBe(`${provider}/${"m".repeat(89)}`);
    expect(displayReviewModel(provider, "m".repeat(90))).toBeNull();
  });

  it("preserves step settings and never assumes a cap", () => {
    const value = decodeModelSettings(settings());
    expect(Either.isRight(value)).toBe(true);

    if (Either.isRight(value)) {
      expect(value.right.judge).toMatchObject({ id: "judge", provider: "synthetic", model: "model", batch_size: 5, max_budget_usd: null });
      expect(piDeadlineSeconds(value.right.judge)).toBe(1800);
    }
  });
  it.each([settings("bare"), settings("p/m", "5.0"), settings("p/m", "11"), settings() + '\nextra = "bad"', "[screen"])("rejects invalid settings", (text) => {
    expect(Either.isLeft(decodeModelSettings(text))).toBe(true);
  });
});
