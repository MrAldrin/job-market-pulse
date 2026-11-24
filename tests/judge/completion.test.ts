import { test } from "vitest";

test("private completion namespace uses exact SQLite DDL and owned identity CAS", async () => { await import("./completion-sqlite.ts"); }, 25_000);
