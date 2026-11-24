import { test } from "vitest";

test("Judge read-only WAL path preserves uncheckpointed rows and main-store metadata", async () => { await import("./wal-sqlite.ts"); }, 25_000);
