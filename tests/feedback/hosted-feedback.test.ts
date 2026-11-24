import { Effect, Either } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { decodeHostedFeedback, readCachedHostedFeedback } from "../../src/lib/server/feedback/hosted-feedback.ts";

const instant = "2026-01-01T12:00:00+00:00";

const star = {
  event_id: `star:invented:${instant}`, listing_id: "invented", source: "nav", source_version: null,
  kind: "star", value: true, reason: "", created_at: instant, origin: "phone_shortlist", result_id: null,
};

const reaction = { ...star, event_id: `reaction:invented:${instant}`, kind: "reaction", value: "up" };

type FixtureJson = null | boolean | number | string | readonly FixtureJson[] | { readonly [key: string]: FixtureJson };

const document = (events: readonly FixtureJson[] = [star, reaction], profileId = "demo") => ({
  schema: "pulse.feedback_events", schema_version: 1, profile_id: profileId, events,
});

const encode = (raw: FixtureJson) => new TextEncoder().encode(JSON.stringify(raw));

test.each([
  encode(document([star], "other")), encode(document([star, star])), encode(document([{ ...star, origin: "local_ratings" }])),
  encode(document([{ ...star, kind: "rating", value: "good" }])), encode(document([{ ...star, kind: "legacy_verdict", value: "good" }])),
  encode(document([{ ...star, kind: null }])), encode(document([{ ...star, value: "true" }])), encode(document([{ ...star, extra: true }])),
  encode({ ...document(), schema_version: 2 }), encode({ ...document(), extra: true }),
  Buffer.from('{"events":[],"events":[]}'), Uint8Array.of(0xff),
  encode(document(Array.from({ length: 50_001 }, () => ({ kind: "future" })))),
])("decodeHostedFeedback rejects malformed or out-of-provenance payload %#", (bytes) => {
  expect(Either.isLeft(decodeHostedFeedback(bytes, "demo"))).toBe(true);
});

test("the local export can read a saved copy but rejects unsafe or unrelated files", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "pulse-feedback-cache-"));
  const selection = { cacheDirectory, profileId: "demo" };
  const path = join(cacheDirectory, "hosted-feedback.json");

  try {
    expect(await Effect.runPromise(readCachedHostedFeedback(selection))).toEqual([]);
    await writeFile(path, encode(document()), { mode: 0o600 });
    expect(await Effect.runPromise(readCachedHostedFeedback(selection))).toEqual([star, reaction]);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(readCachedHostedFeedback({ ...selection, profileId: "other" }))))).toBe(true);
    await chmod(path, 0o644);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(readCachedHostedFeedback(selection))))).toBe(true);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
