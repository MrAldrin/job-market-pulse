import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCatalog, validEntry } from "../../src/lib/server/profile/occupation-catalog.ts";

describe("occupation catalog", () => {
  it("loads tracked choices without limiting other filters", () => {
    const result = decodeCatalog(readFileSync("config/occupation_categories.toml", "utf8"));
    expect(Either.isRight(result)).toBe(true);

    if (Either.isRight(result)) {
      expect(result.right).toHaveLength(14);
      expect(validEntry(" it  /   utvikling ", result.right)).toBe(true);
      expect(validEntry("Synthetic / choice", result.right)).toBe(false);
    }
  });
  it("rejects normalized duplicate labels", () => {
    expect(Either.isLeft(decodeCatalog('[[level1]]\nname="A"\nplain="a"\nlevel2=["Straße", "STRASSE"]'))).toBe(true);
    expect(Either.isLeft(decodeCatalog('[[level1]]\nname="A"\nplain="a"\nlevel2=[]\n[[level1]]\nname=" a "\nplain="a"\nlevel2=[]'))).toBe(true);
  });
});
