import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps delivery ledger replay, claims, confirmation and read-only safety", () => {
  const output = execFileSync("bun", ["tests/alert/ledger-bun.ts"], { encoding: "utf8", timeout: 20_000 });
  expect(output).toContain("ledger: passed");
});
