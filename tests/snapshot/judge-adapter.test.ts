import { it } from "vitest";

it("composes the actual readonly Judge adapter and keeps stage-only first-found reads distinct from failures", async () => { await import("./judge-adapter-bun.ts"); }, 25_000);
