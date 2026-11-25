import { defineConfig } from "vitest/config";

const windowsCi = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/slow/**", "tests/pi_review_bridge.test.ts", "tests/pi_review_provider_serialization.test.ts"],
    environment: "node",
    // Many tests start Bun or PowerShell. Leave CPU time for those child processes.
    maxWorkers: windowsCi ? 2 : 8,
    testTimeout: windowsCi ? 30_000 : 5_000,
  },
});
