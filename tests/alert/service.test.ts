import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps private staging, Discord approval, old artifacts and confirmed-only history separate", () => {
  const output = execFileSync("bun", ["tests/alert/service-bun.ts"], { encoding: "utf8", timeout: 20_000 });

  expect(output).toContain("alert service: passed");
});
