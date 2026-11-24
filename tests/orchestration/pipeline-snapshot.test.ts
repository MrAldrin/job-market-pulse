import { it } from "vitest";

it("captures the retained v1 bundle and rejects late invalid staged digests", async () => { await import("./pipeline-snapshot-bun.ts"); }, 25_000);
