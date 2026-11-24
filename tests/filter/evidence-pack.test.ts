import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeTitleEvidence, INTEREST_PATTERNS_PATH, loadTitleEvidence } from "../../src/lib/server/filter/evidence-pack.ts";
import { manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { makeSourcePolicy } from "../../src/lib/server/filter/source-policy.ts";
import { NEUTRAL_TITLE_EVIDENCE } from "../../src/lib/server/filter/title-evidence.ts";
import { filterSettings, sourceAd, uuid } from "./fixtures.ts";

const base = { schema_version: 1, topics: [{ name: "rescue", pattern: "first aid" }], roles: [], source_tags: ["rescue"] };
const decode = (raw: string) => decodeTitleEvidence(new TextEncoder().encode(raw));

describe("installation-local title evidence", () => {
  it("uses one selected pack for Source callbacks and manifest binding", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const missing = yield* loadTitleEvidence(root);
      const settings = filterSettings();
      const rows = [sourceAd(uuid, "General role", { topics: '["programming", "rescue"]' })];
      const neutral = Either.getOrThrow(makeSourcePolicy(settings, new Map()));
      expect(missing).toBe(NEUTRAL_TITLE_EVIDENCE);
      expect(neutral.rankMissing(rows)[0]?.interest_score).toBe(0);
      yield* fs.makeDirectory(join(root, "local_only", "config"), { recursive: true });
      yield* fs.writeFileString(join(root, INTEREST_PATTERNS_PATH), JSON.stringify(base));
      const installed = yield* loadTitleEvidence(root);
      const policy = Either.getOrThrow(makeSourcePolicy(settings, new Map(), undefined, installed));
      expect(policy.rankMissing(rows)[0]?.interest_score).toBe(1);
      const binding = (evidence: typeof installed) => Either.getOrThrow(manifestCommon("invented", settings, undefined, evidence));
      expect(binding(installed).scoring_version).not.toBe(binding(missing).scoring_version);
      expect(binding(installed).rules_fingerprint).toBe(binding(missing).rules_fingerprint);
      yield* fs.writeFileString(join(root, INTEREST_PATTERNS_PATH), JSON.stringify({ ...base, source_tags: [] }));
      expect((yield* loadTitleEvidence(root)).scoringVersion).not.toBe(installed.scoringVersion);
      yield* fs.writeFileString(join(root, INTEREST_PATTERNS_PATH), "{");
      expect(Either.isLeft(yield* Effect.either(loadTitleEvidence(root)))).toBe(true);
    })).pipe(Effect.provide(BunContext.layer)));
  });

  it.each([
    JSON.stringify({ ...base, legacy: true }),
    JSON.stringify({ ...base, schema_version: 2 }),
    JSON.stringify({ ...base, source_tags: ["rescue", "rescue"] }),
    JSON.stringify({ ...base, source_tags: ["term: rescue"] }),
    JSON.stringify({ ...base, topics: [{ name: "rescue", pattern: "[" }] }),
    JSON.stringify({ ...base, roles: [{ name: "rescue", pattern: "first aid" }, { name: "rescue", pattern: "rescue" }] }),
    '{"schema_version":1,"schema_version":1,"topics":[],"roles":[],"source_tags":[]}',
  ])("rejects an invalid pack without claiming a legacy version", (text) => {
    expect(Either.isLeft(decode(text))).toBe(true);
  });
});
