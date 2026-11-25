import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// This case checks real Windows ACLs on repeated outbox and ledger access.
const childTimeout = process.platform === "win32" ? 80_000 : 20_000;

it("keeps private staging, Discord approval, old artifacts and confirmed-only history separate", () => {
  const output = execFileSync("bun", ["tests/alert/service-bun.ts"], { encoding: "utf8", timeout: childTimeout });

  expect(output).toContain("alert service: passed");
}, process.platform === "win32" ? childTimeout + 5_000 : undefined);
