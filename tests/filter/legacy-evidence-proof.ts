import assert from "node:assert/strict";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Schema } from "effect";
import { assess } from "../../src/lib/server/filter/assessment.ts";
import { decodeTitleEvidence, INTEREST_PATTERNS_PATH, loadTitleEvidence } from "../../src/lib/server/filter/evidence-pack.ts";
import { buildManifest, manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { stageInputFingerprint } from "../../src/lib/server/filter/stage-fingerprint.ts";
import type { TitleEvidence } from "../../src/lib/server/filter/title-evidence.ts";
import { completionTransaction, persistReviewedIds, reviewedIds } from "../../src/lib/server/judge/completion.ts";
import { openJudgeConnection } from "../../src/lib/server/judge/database.ts";
import { pythonJson, sha256 } from "../../src/lib/server/shared/python-json.ts";
import { legacyEvidenceCandidate as row, legacyEvidenceCases, legacyEvidenceSettings } from "./legacy-evidence-cases.ts";

// Frozen before the change, from the old scorer and manifest constructors using
// only the synthetic cases. The private base's pattern file is supplied locally.
const old = {
  assessment: "c4a6266cf9d165391ca35d865c34d3bfd4338de9aa1b3d2e17ae7e79b86a98ef",
  scoring_version: "title-evidence-hard-radius-v3",
  coverage_id: "a62522b450432f85718f5a8954ecc2f4134e96d26f1a345a3aec2e8a0571636f",
  manifest_id: "4960ce687e6cb73a3e0954ee185b8d49ac113aa09272420d422f13c0ca06fd5b",
  screen: "c3cbe41376a74d59445ecf5788fced38fec72e8557c558e964f7f648477dc69f",
  full: "123e6bcd86a56542403c39e0dd07749992f85317e96bb1dcd56012ceeaed9dce",
};

const settings = legacyEvidenceSettings();
const built = (evidence: TitleEvidence) => Either.getOrThrow(buildManifest(Either.getOrThrow(manifestCommon("fixture", settings, undefined, evidence)), [row], row.version));

const hashes = (manifest: ReturnType<typeof built>) => ({
  screen: Either.getOrThrow(stageInputFingerprint(manifest, row, { stage: "title_screen", promptVersion: "synthetic-v1" })),
  full: Either.getOrThrow(stageInputFingerprint(manifest, row, { stage: "full_review", promptVersion: "synthetic-v1", sourceTextFingerprint: "e".repeat(64), upstreamResultId: "synthetic-screen" })),
});

const packOutput = Bun.argv[2];

assert(packOutput, "Pass an extracted interest-patterns.json from the legacy base");

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(packOutput);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-legacy-proof-" });
  yield* fs.makeDirectory(join(root, "local_only", "config"), { recursive: true });
  yield* fs.writeFile(join(root, INTEREST_PATTERNS_PATH), bytes);
  const installed = yield* loadTitleEvidence(root);
  const actual = built(installed);
  const assessments = legacyEvidenceCases.map(([title, topics]) => assess(title, "Synthetic", [], [], topics, settings.preferences, () => null, installed));
  const { scoring_version, coverage_id, manifest_id } = actual;
  assert.deepEqual({ assessment: sha256(pythonJson(assessments.map((assessment) => ({ ...assessment })))), scoring_version, coverage_id, manifest_id, ...hashes(actual) }, old);

  const ledger = yield* openJudgeConnection({ profile_id: "fixture", directory: root, path: join(root, "review.sqlite3"), readonly: false, require_existing: false }, "completion-ledger");
  yield* completionTransaction(ledger, persistReviewedIds(ledger, {
    manifest: { ...actual, scoring_version: old.scoring_version, manifest_id: old.manifest_id },
    assessments: [{ id: row.id, version: row.version }], recorded_at: row.version, raw_review: { synthetic: true },
  }));
  assert.deepEqual(yield* reviewedIds(ledger, actual), new Set([row.id]));

  const inspection = Schema.parseJson(Schema.Struct({
    schema_version: Schema.Literal(1),
    topics: Schema.Array(Schema.Struct({ name: Schema.String, pattern: Schema.String })),
    roles: Schema.Array(Schema.Struct({ name: Schema.String, pattern: Schema.String })),
    source_tags: Schema.Array(Schema.String),
  }));

  const raw = yield* Schema.decodeUnknown(inspection)(new TextDecoder().decode(bytes));

  const decoded = (value: typeof raw) => Either.getOrThrow(decodeTitleEvidence(new TextEncoder().encode(JSON.stringify(value, null, 2))));
  assert.equal(built(decoded(raw)).manifest_id, old.manifest_id);

  for (const change of [{ topics: raw.topics.slice(1) }, { roles: raw.roles.slice(1) }, { source_tags: raw.source_tags.slice(1) }]) {
    const changed = built(decoded({ ...raw, ...change }));
    assert.notEqual(changed.scoring_version, old.scoring_version);
    assert.notEqual(changed.coverage_id, old.coverage_id);
    assert.notEqual(changed.manifest_id, old.manifest_id);
    assert.notEqual(hashes(changed).screen, old.screen);
    assert.notEqual(hashes(changed).full, old.full);
    assert.deepEqual(yield* reviewedIds(ledger, changed), new Set());
  }

  yield* fs.remove(join(root, INTEREST_PATTERNS_PATH));
  assert.deepEqual(yield* reviewedIds(ledger, built(yield* loadTitleEvidence(root))), new Set());
})).pipe(Effect.provide(BunContext.layer)));

console.log("Legacy evidence: assessment, manifest, stage and completion ledger bindings match only the exact pack");
