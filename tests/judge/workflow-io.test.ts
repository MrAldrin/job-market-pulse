import { test } from "vitest";

// The Windows fixture compiles the fake harness and checks ACLs on real databases.
const workflowTimeout = process.platform === "win32" ? 50_000 : 25_000;

test("Judge JSONL and native offline driver hold scope and record actual receipts", async () => { await import("./workflow-io-sqlite.ts"); }, workflowTimeout);
