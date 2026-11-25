import { test } from "vitest";

// The fixture opens real stores and invokes native Windows ACL checks.
test("workflow-controller orchestrates real canonical stores and retains shell telemetry ownership", async () => { await import("./workflow-controller-sqlite.ts"); }, process.platform === "win32" ? 75_000 : 25_000);
