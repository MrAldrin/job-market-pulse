import { test } from "vitest";

test("Judge schema uses real Bun SQLite for frozen initialization and readonly compatibility", async () => { await import("./schema-sqlite.ts"); }, 25_000);
