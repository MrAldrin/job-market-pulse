import { test } from "vitest";

test("canonical selected Profile and Source workflows bind completion and retained views", async () => { await import("./workflows-sqlite.ts"); }, 25_000);
