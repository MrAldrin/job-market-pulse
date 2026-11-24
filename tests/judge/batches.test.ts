import { test } from "vitest";

test("private Judge batch persistence uses real binding, expiry and transaction checks", async () => { await import("./batches-sqlite.ts"); }, 25_000);
