import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("records two weekly series atomically and reads frozen/legacy stores without writes", () => {
  // One synchronous Bun helper; no subprocesses or live services inside it.
  const output = execFileSync("bun", ["tests/market/store-cases.ts"], { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("Market store: passed");
});
