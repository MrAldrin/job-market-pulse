import { test } from "vitest";

test("retained historical results stay readable without import or invented stage evidence", async () => { await import("./history-sqlite.ts"); }, 25_000);
