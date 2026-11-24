import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it.each(["facets", "public-raw", "public-owned", "clocks", "resolve-public-clock", "resolve-direct-clock"])("keeps selected SQLite resource ownership: %s", (group) => {
  // One synchronous Bun helper per Vitest worker. The helper starts no subprocesses.
  const output = execFileSync("bun", ["tests/source/resource-cases.ts", group], { encoding: "utf8", timeout: 20_000 });
  expect(output).toContain(`${group}: passed`);
});
