import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { CandidateManifest } from "../../src/lib/contracts/filter.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { decodeReview, decodeReviewJson, reviewTemplate, validateReview, validateGeneratedReviewObject } from "../../src/lib/server/filter/review.ts";

const get = <A>(result: Either.Either<A, unknown>): A => {
  if (Either.isLeft(result)) throw new Error("Invalid synthetic fixture");

  return result.right;
};

const manifest = get(Either.flatMap(parseJsonInput(readFileSync("tests/oracle/basic-run/filter/run-1.json", "utf8")), decodeStrict(CandidateManifest)));
const now = 1_792_414_800_000_000n; // 2026-10-19T13:00:00Z

const rawReview = () => ({
  schema_version: 1n, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id,
  assessed_at: "2026-10-19T13:00:00+00:00", complete: true,
  assessments: manifest.candidates.map((candidate) => ({
    id: candidate.id, version: null, fit: "exceptional", reason: "Invented evidence supports the work.",
    evidence: ["Invented full ad describes the role."], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true,
  })),
});

describe("supplied review validation", () => {
  it("validates generated in-process numeric-version objects through the same canonical rules", () => {
    const generated = { ...rawReview(), schema_version: 1 };
    const expected = get(validateReview(manifest, get(decodeReview(rawReview())), now));

    expect(get(validateGeneratedReviewObject(manifest, generated, now))).toEqual(expected);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, rawReview(), now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, reviewTemplate(manifest), now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, { ...generated, extra: true }, now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, { ...generated, schema_version: true }, now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, { ...generated, assessments: [] }, now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, { ...generated, profile_id: "other" }, now))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, generated, now, 0n))).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, generated, now + 2n * 86_400_000_000n))).toBe(true);
  });

  it("does not replace the encoded JSON lexical integer or own-key validation path", () => {
    const encoded = pythonJson(rawReview());

    expect(Either.isRight(decodeReviewJson(encoded))).toBe(true);

    for (const token of ["1.0", "1e0"]) {
      expect(Either.isLeft(decodeReviewJson(encoded.replace('"schema_version":1', '"schema_version":' + token)))).toBe(true);
    }

    const generated = { ...rawReview(), schema_version: 1 };
    const ownExtra = Object.fromEntries([...Object.entries(generated), ["__proto__", { injected: true }]]);

    expect(Object.hasOwn(ownExtra, "__proto__")).toBe(true);
    expect(Either.isLeft(validateGeneratedReviewObject(manifest, ownExtra, now))).toBe(true);
  });

  it("trusts the manifest version, not the echoed version", () => {
    const rows = get(validateReview(manifest, get(decodeReview(rawReview())), now));

    expect(rows).toHaveLength(manifest.candidates.length);
    expect(rows[0]?.version).toBe(manifest.candidates[0]?.version);
    expect(rows[0]?.title).toBe(manifest.candidates[0]?.title);
    expect(rows[0]?.assessed_at).toBe("2026-10-19T13:00:00+00:00");
  });

  it.each(["reason", "evidence", "uncertainties"] as const)("measures stripped %s scalar length and retains the original submitted value", (field) => {
    for (const content of ["x".repeat(1000), "😀".repeat(1000)]) {
      const text = "\u001c \u0085" + content + "\u001f";
      const review = rawReview();
      const value = field === "reason" ? text : [text];
      const input = { ...review, assessments: review.assessments.map((row, index) => index === 0 ? { ...row, fit: "possible", [field]: value } : row) };
      const decoded = get(decodeReviewJson(pythonJson(input)));

      expect(decoded.assessments[0]?.[field]).toEqual(value);
      expect(get(validateReview(manifest, decoded, now))).toHaveLength(manifest.candidates.length);
    }
  });

  it.each(["reason", "evidence", "uncertainties"] as const)("rejects empty, overlong and non-Python-whitespace %s values after stripping", (field) => {
    for (const text of ["\u001c \u0085\u001f", " " + "x".repeat(1001) + " ", "\ufeff" + "x".repeat(1000) + "\ufeff"]) {
      const review = rawReview();
      const value = field === "reason" ? text : [text];
      const input = { ...review, assessments: review.assessments.map((row, index) => index === 0 ? { ...row, fit: "possible", [field]: value } : row) };

      expect(Either.isLeft(decodeReviewJson(pythonJson(input)))).toBe(true);
    }
  });

  it("never turns the deliberately incomplete template into success", () => {
    expect(Either.isLeft(decodeReview(reviewTemplate(manifest)))).toBe(true);
  });

  it("requires every submitted candidate exactly once and binds profile and manifest", () => {
    const review = get(decodeReview(rawReview()));

    expect(Either.isLeft(validateReview(manifest, { ...review, assessments: [] }, now))).toBe(true);
    expect(Either.isLeft(validateReview(manifest, { ...review, profile_id: "other" }, now))).toBe(true);
    expect(Either.isLeft(validateReview(manifest, { ...review, manifest_id: "f".repeat(64) }, now))).toBe(true);
    expect(Either.isLeft(decodeReview({ ...rawReview(), attacker_url: "https://invalid.example" }))).toBe(true);
  });

  it("rejects exceptional uncertainty, unknown constraints and missing ad evidence", () => {
    for (const mutation of [{ uncertainties: ["Unknown requirement"] }, { hard_constraints: "unknown" }, { evidence: [] }, { ad_text_reviewed: false }]) {
      const review = rawReview();
      const row = review.assessments[0];

      if (row === undefined) throw new Error("Missing fixture candidate");
      const decoded = get(decodeReview({ ...review, assessments: [{ ...row, ...mutation }, ...review.assessments.slice(1)] }));

      expect(Either.isLeft(validateReview(manifest, decoded, now))).toBe(true);
    }
  });

  it("rejects floating schema versions and missing fields before use", () => {
    expect(Either.isLeft(decodeReview({ ...rawReview(), schema_version: 1 }))).toBe(true);
    const review = rawReview();
    const row = review.assessments[0];

    if (row === undefined) throw new Error("Missing fixture candidate");
    const { version: _removed, ...withoutVersion } = row;

    expect(Either.isLeft(decodeReview({ ...review, assessments: [withoutVersion, ...review.assessments.slice(1)] }))).toBe(true);
  });

  it("rechecks source age, assessment order and candidate expiry", () => {
    const review = get(decodeReview(rawReview()));

    expect(Either.isLeft(validateReview(manifest, review, now + 2n * 86_400_000_000n))).toBe(true);
    expect(Either.isLeft(validateReview(manifest, { ...review, assessed_at: "2026-10-18T00:00:00Z" }, now))).toBe(true);
    expect(Either.isLeft(validateReview({ ...manifest, candidates: manifest.candidates.map((item) => ({ ...item, expires_at: "2026-10-19T11:00:00Z" })) }, review, now))).toBe(true);
  });
});
