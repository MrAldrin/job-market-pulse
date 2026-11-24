import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Source review text offline Bun cases", () => {
  for (const group of ["decision", "binding", "fetch"]) {
    it(`checks ${group} against synthetic inputs`, () => {
      const output = execFileSync("bun", ["tests/source/review-text-cases.ts", group], { encoding: "utf8", timeout: 20_000 });
      expect(output).toContain(`${group}: passed`);
    });
  }
});
