import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";

describe("observation history", () => {
  it.each(["migrations", "legacy", "refusals", "history", "profiles", "invalids", "atomicity"])("preserves %s behavior in real temporary SQLite stores", (name) => {
    execFileSync("bun", ["tests/source/observation-cases.ts", name], { stdio: "pipe", timeout: 15_000 });
  }, 20_000);
});
