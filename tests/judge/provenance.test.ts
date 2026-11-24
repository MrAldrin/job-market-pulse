import { Either } from "effect";
import { describe, expect, test } from "vitest";
import { fingerprint } from "../../src/lib/server/judge/core.ts";
import { buildStageInputs, stageInputFingerprint } from "../../src/lib/server/judge/inputs.ts";
import { judgeCandidate, judgeManifest } from "./fixtures.ts";
import { parseSnapshotProvenance, snapshotBindingId, validateSnapshotAdmission } from "../../src/lib/server/judge/provenance.ts";

const digest = "a".repeat(64);
const listing = "00000000-0000-0000-0000-000000000001";
const upstream = "00000000-0000-0000-0000-000000000002";
const sourceVersion = "2026-10-01T10:00:00Z";
const expiry = "2026-11-01T10:00:00Z";
const current = { format_version: 1, snapshot_id: digest, expires_at: expiry, provenance: null };

const candidate = judgeCandidate(listing, sourceVersion, { title: "Analyst", employer: "Invented", expires_at: expiry });
const manifest = judgeManifest([candidate], sourceVersion);
const projected = manifest.candidates[0];

if (!projected) throw new Error("Missing invented fixture");

describe("bounded raw snapshot provenance", () => {
  test("retains legacy identity and binds normalized current expiry and source clock", () => {
    expect(Either.getOrThrow(parseSnapshotProvenance(null))).toBeNull();
    expect(Either.getOrThrow(snapshotBindingId(JSON.stringify({ snapshot_id: digest, provenance: null })))).toBe(digest);
    expect(Either.getOrThrow(snapshotBindingId(JSON.stringify(current), sourceVersion))).toBe(fingerprint({ format_version: 1, snapshot_id: digest, expires_at: "2026-11-01T10:00:00+00:00", detail_changed: "2026-10-01T10:00:00+00:00" }));
    const offset = { ...current, expires_at: "2026-11-01T11:00:00+01:00" };
    expect(Either.getOrThrow(snapshotBindingId(JSON.stringify(offset), sourceVersion))).toBe(Either.getOrThrow(snapshotBindingId(JSON.stringify(current), sourceVersion)));
  });

  test("rejects malformed retained snapshot bindings and duplicate version keys", () => {
    for (const text of [
      JSON.stringify(current).replace('"format_version":1', '"format_version":1.0'),
      JSON.stringify(current).replace('"format_version":1', '"format_version":1,"format_version":1'),
      JSON.stringify({ ...current, snapshot_id: null }),
      JSON.stringify({ ...current, expires_at: "unaware" }),
    ]) expect(Either.isLeft(parseSnapshotProvenance(text))).toBe(true);

  });

  test("refresh must advance, bind the admitted source and not extend source expiry", () => {
    const refresh = { source: "nav_detail_refresh", previous_changed: sourceVersion, detail_changed: "2026-10-01T12:00:00+01:00", refreshed_at: "2026-10-01T11:01:00Z" };
    const parsed = Either.getOrThrow(parseSnapshotProvenance(JSON.stringify({ ...current, provenance: refresh })));
    expect(parsed?.refresh?.detail_changed).toBe("2026-10-01T11:00:00+00:00");
    expect(Either.isRight(validateSnapshotAdmission(parsed, sourceVersion, expiry))).toBe(true);
    expect(Either.isLeft(validateSnapshotAdmission(parsed, "2026-10-02T10:00:00Z", expiry))).toBe(true);
    expect(Either.isLeft(validateSnapshotAdmission(parsed, sourceVersion, "2026-10-31T10:00:00Z"))).toBe(true);
    expect(Either.isLeft(validateSnapshotAdmission(Either.getOrThrow(parseSnapshotProvenance(JSON.stringify({ ...current, expires_at: null, provenance: refresh }))), sourceVersion, expiry))).toBe(true);
    expect(Either.isLeft(validateSnapshotAdmission(Either.getOrThrow(parseSnapshotProvenance(JSON.stringify({ snapshot_id: digest, provenance: refresh }))), sourceVersion, expiry))).toBe(true);
    expect(Either.isLeft(parseSnapshotProvenance(JSON.stringify({ ...current, provenance: { ...refresh, detail_changed: sourceVersion } })))).toBe(true);
    const duplicate = JSON.stringify({ ...current, provenance: refresh }).replace('"source":"nav_detail_refresh"', '"source":"nav_detail_refresh","source":"nav_detail_refresh"');
    expect(Either.isLeft(parseSnapshotProvenance(duplicate))).toBe(true);
  });
});

describe("private stage and raw value bindings", () => {
  test("coverage and whole-manifest changes do not invalidate exact candidate inputs", () => {
    const base = Either.getOrThrow(stageInputFingerprint(manifest, projected, "title_screen", "prompt"));
    expect(Either.getOrThrow(stageInputFingerprint({ ...manifest, coverage_id: "b".repeat(64), manifest_id: "other" }, projected, "title_screen", "prompt"))).toBe(base);
    expect(Either.getOrThrow(stageInputFingerprint({ ...manifest, rules_fingerprint: "b".repeat(64) }, projected, "title_screen", "prompt"))).not.toBe(base);
    expect(Either.isLeft(stageInputFingerprint(manifest, projected, "title_screen", "prompt", digest))).toBe(true);
    expect(Either.isLeft(stageInputFingerprint(manifest, projected, "full_review", "prompt", digest, digest))).toBe(true);
  });

  test("ad content ignores timestamp-only changes but binds metadata, upstream and prompt", () => {
    const base = Either.getOrThrow(stageInputFingerprint(manifest, projected, "full_review", "prompt", digest, digest, upstream));
    const changed = { ...projected, version: "2026-10-02T10:00:00Z" };
    expect(Either.getOrThrow(stageInputFingerprint(manifest, changed, "full_review", "prompt", digest, digest, upstream))).toBe(base);
    expect(Either.getOrThrow(stageInputFingerprint(manifest, { ...projected, title: "Changed" }, "full_review", "prompt", digest, digest, upstream))).not.toBe(base);
    expect(Either.getOrThrow(stageInputFingerprint(manifest, projected, "full_review", "prompt", digest, digest, listing))).not.toBe(base);
    expect(Either.getOrThrow(stageInputFingerprint(manifest, projected, "full_review", "other", digest, digest, upstream))).not.toBe(base);
    expect(Either.getOrThrow(stageInputFingerprint(manifest, changed, "title_screen", "prompt"))).not.toBe(Either.getOrThrow(stageInputFingerprint(manifest, projected, "title_screen", "prompt")));
  });

  test("stage inputs require exact unique requested identities", () => {
    expect(Either.getOrThrow(buildStageInputs(manifest, { stage: "title_screen", prompt_version: "prompt" }))).toHaveLength(1);
    expect(Either.isLeft(buildStageInputs(manifest, { stage: "title_screen", prompt_version: "prompt", candidate_ids: [listing, listing] }))).toBe(true);
    expect(Either.isLeft(buildStageInputs(manifest, { stage: "title_screen", prompt_version: "prompt", candidate_ids: [upstream] }))).toBe(true);
  });

  test("current snapshot identity uses the normalized Source clock", () => {
    const utc = "2026-10-01T10:00:00.123456Z";
    const offset = "2026-10-01T11:00:00.123456+01:00";
    expect(Either.getOrThrow(snapshotBindingId(JSON.stringify(current), utc))).toBe(Either.getOrThrow(snapshotBindingId(JSON.stringify(current), offset)));
  });
});
