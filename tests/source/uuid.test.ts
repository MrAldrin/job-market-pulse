import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import properties from "../../resources/profile/unicode-properties-15.1.json";
import { uuid } from "../../src/lib/server/source/core.ts";

const canonical = (hex: string): string => [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
const decoded = (value: string): string => Either.getOrThrow(uuid(value));

// Tagged CPython v3.13.11 Lib/uuid.py:177–182 and Objects/longobject.c:3114ff.
// Source inspection and Bun/Node tests only; no CPython execution or recorder.
describe("frozen UUID(hex) input language", () => {
  it("normalizes canonical values, repeated wrappers and internal removal tokens", () => {
    const hex = "1234567890abcdef1234567890abcdef";
    expect(decoded("urn:uuid:{{" + canonical(hex.toUpperCase()) + "}}")).toBe(canonical(hex));
    expect(decoded(hex.slice(0, 16) + "urn:uuid:" + hex.slice(16))).toBe(canonical(hex));
    expect(decoded("--" + hex + "---")).toBe(canonical(hex));
  });
  it("keeps Python int16 plus, prefix and legal underscore spellings", () => {
    const cases = [
      ["+" + "0".repeat(31), "0".repeat(32)],
      ["0x" + "f".repeat(30), "00" + "f".repeat(30)],
      ["0x" + "0".repeat(30), "0".repeat(32)],
      ["0".repeat(15) + "_" + "0".repeat(16), "0".repeat(32)],
      ["٠".repeat(32), "0".repeat(32)],
      ["0b" + "0".repeat(30), "0b" + "0".repeat(30)],
      ["+0X" + "f".repeat(29), "000" + "f".repeat(29)],
      ["0x_" + "f".repeat(29), "000" + "f".repeat(29)],
      ["f".repeat(15) + "_" + "f".repeat(16), "0" + "f".repeat(31)],
      [" " + "f".repeat(30) + "\t", "00" + "f".repeat(30)],
      ["\u0085" + "f".repeat(30) + "\u3000", "00" + "f".repeat(30)],
      ["٠x" + "f".repeat(30), "00" + "f".repeat(30)],
    ] as const;

    for (const [input, expected] of cases) expect(decoded(input), input).toBe(canonical(expected));
  });
  it("accepts every frozen Unicode15.1 Nd digit by scalar count, including astral digits", () => {
    for (const [start = 0, end = -1] of properties.decimal) {
      for (let point = start; point <= end; point++) {
        const digit = String((point - start) % 10);
        expect(decoded(String.fromCodePoint(point).repeat(32)), point.toString(16)).toBe(canonical(digit.repeat(32)));
      }
    }

    expect(decoded("𝟙".repeat(32))).toBe(canonical("1".repeat(32)));
    expect(decoded("+" + "𝟡".repeat(31))).toBe(canonical("0" + "9".repeat(31)));
  });
  it("rejects malformed int16 forms, wrong scalar lengths and non-frozen digits", () => {
    const cases = [
      "0".repeat(31), "0".repeat(33), "𝟙".repeat(31), "𝟙".repeat(33),
      "_" + "0".repeat(31), "0".repeat(31) + "_", "0".repeat(14) + "__" + "0".repeat(16),
      "++" + "0".repeat(30), "0x__" + "0".repeat(28), "0x" + "_".repeat(30),
      "0b" + "0".repeat(30) + "x", "０Ｘ" + "0".repeat(30), "＋" + "0".repeat(31),
      "\u001c" + "0".repeat(31), "\u001d" + "0".repeat(31), "\u001e" + "0".repeat(31), "\u001f" + "0".repeat(31),
      "\ufeff" + "0".repeat(31), "\ud800" + "0".repeat(31),
      "\u{10d40}".repeat(32), "²".repeat(32), "Ａ".repeat(32), "z".repeat(32),
      "-{00" + "0".repeat(30) + "}-",
    ];

    for (const input of cases) expect(Either.isLeft(uuid(input)), JSON.stringify(input)).toBe(true);
  });
  it("round-trips all generated 128-bit values without changing numeric identity", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (value) => {
      const hex = value.toString(16).padStart(32, "0");
      expect(decoded(hex)).toBe(canonical(hex));
      expect(decoded("urn:uuid:{" + canonical(hex) + "}")).toBe(canonical(hex));
    }), { numRuns: 100, seed: 74528 });
    expect(decoded("f".repeat(32))).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});
