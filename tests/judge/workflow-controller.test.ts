import { test } from "vitest";

test("workflow-controller orchestrates real canonical stores and retains shell telemetry ownership", async () => { await import("./workflow-controller-sqlite.ts"); }, 25_000);
