import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

for (const group of ["inert", "resources", "workflow"]) {
  it(`keeps Source ${group} boundaries explicit and scoped`, () => {
    expect(execFileSync("bun", ["tests/source/service-cases.ts", group], { encoding: "utf8", timeout: 20_000 })).toContain(`${group}: passed`);
  }, 30_000);
}
