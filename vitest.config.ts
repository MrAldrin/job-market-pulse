import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/**/*.test.ts"], exclude: ["tests/slow/**", "tests/pi_review_bridge.test.ts", "tests/pi_review_provider_serialization.test.ts"], environment: "node", maxWorkers: 8 } });
