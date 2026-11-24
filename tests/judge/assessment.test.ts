import { Either } from "effect";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AssessmentBatch } from "../../src/lib/contracts/assessment.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { parseStrictContractJson } from "../../src/lib/server/shared/strict-contract-json.ts";

const uncertainties: string[] = [];
const row = { id: "synthetic", version: "synthetic-version", fit: "strong", reason: "Synthetic evidence supports the role.", evidence: ["Synthetic software work."], uncertainties, hard_constraints: "pass", ad_text_reviewed: true };
const document = (rows = [row]) => ({ schema: "pulse.assessment", schema_version: 1n, assessments: rows });
const decode = decodeStrict(AssessmentBatch);

describe("offline assessment contract", () => {
  it("validates the unchanged contract fixture without claiming Source admission", () => {
    const raw = parseStrictContractJson(readFileSync("contracts/fixtures/assessment.example.json", "utf8"), 2_000_000);
    expect(Either.isRight(Either.flatMap(raw, decode))).toBe(true);
  });
  it("requires exact header/row fields, unique IDs and bounded batch size", () => {
    for (const value of [{ ...document(), extra: true }, { ...document(), schema_version: 1 }, document([{ ...row, version: "" }]), document([row, row]), document(Array.from({ length: 121 }, (_, index) => ({ ...row, id: String(index) }))), document([{ ...row, reason: " " }])]) expect(Either.isLeft(decode(value))).toBe(true);
    expect(Either.isRight(decode(document([])))).toBe(true);
  });
  it("retains the canonical trimmed scalar bound and supplied text", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1001 }), fc.integer({ min: 0, max: 30 }), (count, padding) => {
      const reason = " ".repeat(padding) + "😀".repeat(count) + "\t".repeat(padding);
      const result = decode(document([{ ...row, reason }]));
      expect(Either.isRight(result)).toBe(count <= 1000);

      if (Either.isRight(result)) expect(result.right.assessments[0]?.reason).toBe(reason);
    }));
  });
  it("enforces offline strong and exceptional evidence rules", () => {
    for (const changed of [{ ad_text_reviewed: false }, { evidence: [] }, { fit: "exceptional", uncertainties: ["Unresolved synthetic condition"] }, { fit: "exceptional", hard_constraints: "unknown" }]) expect(Either.isLeft(decode(document([{ ...row, ...changed }])))).toBe(true);
    expect(Either.isRight(decode(document([{ ...row, fit: "possible", evidence: [], ad_text_reviewed: false }])))).toBe(true);
  });
});
