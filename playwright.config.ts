import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/slow",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4173", headless: true },
  webServer: { command: "bun tests/slow/servers.ts", url: "http://127.0.0.1:4173/healthz", reuseExistingServer: false, timeout: 60_000, gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 } },
});
