import { test } from "vitest";

test("selected Judge resource and state transitions use real scoped Bun SQLite", async () => { await import("./state-sqlite.ts"); }, 25_000);
