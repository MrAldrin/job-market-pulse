import { Effect, Either, Layer, Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { parseIsoTime } from "../../src/lib/contracts/iso-time.ts";
import { parseRequest, parseRequestJson, selectDigest } from "../../src/lib/server/select/core.ts";
import { digestJson, encodeDigestJson, renderHtml, renderText } from "../../src/lib/server/select/digest-render.ts";
import { AssessmentRequests, DigestSelection, DigestSelectionLive } from "../../src/lib/server/select/service.ts";
import { DigestInputError } from "../../src/lib/server/select/errors.ts";
import { BunFileSystem } from "@effect/platform-bun";
import { compareDigestBoundaries } from "../oracle/select.ts";

const now = Option.getOrThrow(parseIsoTime("2026-10-17T12:00:00Z")).epochMicros;

const emptyUncertainties = (): string[] => [];
const emptyDelivered = (): { id: string; version: string }[] => [];

const candidate = (id = "one", fit = "exceptional") => ({ id, version: "v1", title: "Role " + id, employer: "Example AS",
  url: "https://arbeidsplassen.nav.no/stillinger/stilling/" + id, fit, reason: "Evidence supports this match.",
  hard_constraints: { location: "pass" }, assessed_at: "2026-10-17T11:55:00Z", expires_at: "2026-10-19T12:00:00Z", uncertainties: emptyUncertainties() });

const request = (candidates = [candidate()]) => ({ schema_version: 1n, profile_id: "owner", profile_fingerprint: "a".repeat(64),
  mode: "passive", snapshot: { checked_at: "2026-10-17T11:50:00Z", caught_up: true }, assessments_complete: true,
  hard_constraints: ["location"], candidates, delivered: emptyDelivered(),
});

const run = (input = request(), options = {}) => Either.getOrThrow(selectDigest(Either.getOrThrow(parseRequest(input)), now, options));
const wire = (input = request()) => pythonJson(input);

describe("pulse_digest selection", () => {
  it.each(["passive", "active"])("keeps input order and caps %s at 120, with no quota", (mode) => {
    const input = { ...request(Array.from({ length: 121 }, (_, index) => candidate(String(index), mode === "active" ? "strong" : "exceptional"))), mode };
    expect(run(input).candidates.map((item) => item.id)).toEqual(Array.from({ length: 120 }, (_, index) => String(index)));
    expect(run(request(), { maxCount: 0 }).status).toBe("quiet");
    expect(run(request(), { maxCount: 1 }).candidates).toHaveLength(1);
  });
  it("never fills a quota when no assessments qualify", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("possible", "poor"), { maxLength: 100 }), fc.constantFrom("active", "passive"), (fits, mode) => {
      expect(run({ ...request(fits.map((fit, index) => candidate(String(index), fit))), mode }).candidates).toEqual([]);
    }));
  });
  it("checks source blockers first, then deduplicates candidate blockers in insertion order", () => {
    const input = request();
    input.assessments_complete = false;
    input.snapshot.caught_up = false;
    input.snapshot.checked_at = "2026-10-18T12:00:00Z";
    expect(run(input).blocked_reasons).toEqual(["assessments_incomplete", "source_not_caught_up", "source_timestamp_in_future"]);
    const items = [candidate("a", "unknown"), candidate("b"), candidate("c", "unknown")];
    const parsed = Either.getOrThrow(parseRequest(request(items)));
    expect(Either.getOrThrow(selectDigest({ ...parsed, candidates: parsed.candidates.map((item) => item.id === "b" ? { ...item, expires_at: null } : item) }, now)).blocked_reasons).toEqual(["fit_assessment_unknown", "candidate_expiry_unknown"]);
  });
  it("excludes delivered, expired and failed before uncertainty; does not ignore unknown poor fits", () => {
    const item = { ...candidate("one", "unknown"), hard_constraints: { location: "fail" } };
    expect(run(request([item])).status).toBe("quiet");
    const input = request([candidate("one", "unknown")]);
    input.delivered = [{ id: "one", version: "v1" }];
    expect(run(input).status).toBe("quiet");
    expect(run(request([candidate("one", "unknown")])).blocked_reasons).toEqual(["fit_assessment_unknown"]);
  });
  it("uses inclusive freshness and expiry comparisons at microsecond precision", () => {
    const parsed = Either.getOrThrow(parseRequest(request()));
    const exact = { ...parsed, snapshot: { ...parsed.snapshot, checked_at: now - 10n }, candidates: [{ ...parsed.candidates[0]!, assessed_at: now - 10n, expires_at: now + 1n }] };
    expect(Either.getOrThrow(selectDigest(exact, now, { maxAgeMicros: 10n })).status).toBe("ready");
    expect(Either.getOrThrow(selectDigest(exact, now + 1n, { maxAgeMicros: 10n })).blocked_reasons).toEqual(["source_stale"]);
    expect(Either.getOrThrow(selectDigest({ ...exact, candidates: [{ ...exact.candidates[0]!, expires_at: now }] }, now)).status).toBe("quiet");

    for (const options of [{ maxCount: 121 }, { maxCount: -1 }, { maxCount: 1.5 }, { maxAgeMicros: 0n }]) expect(Either.isLeft(selectDigest(parsed, now, options))).toBe(true);
  });
});

describe("pulse_digest boundary", () => {
  it("rejects extra/missing fields, raw noninteger header, surrogate text and incomplete constraints", () => {
    for (const input of [{ ...request(), extra: true }, { ...request(), schema_version: 1 }, { ...request(), schema_version: true }, { ...request(), candidates: [{ ...candidate(), reason: "\ud800" }] }, { ...request(), candidates: [{ ...candidate(), hard_constraints: {} }] }, request([candidate(), candidate()])]) expect(Either.isLeft(parseRequest(input))).toBe(true);

    for (const header of ["1.0", "1e0", "true"]) expect(Either.isLeft(parseRequestJson(wire().replace('"schema_version":1', '"schema_version":' + header)))).toBe(true);
    const parsed = Either.getOrThrow(parseRequest(request()));
    expect(Either.isRight(selectDigest(parsed, now))).toBe(true);
    expect(Either.isLeft(selectDigest({ ...parsed, candidates: [{ ...parsed.candidates[0]!, hard_constraints: {} }] }, now))).toBe(true);
  });
  it("rejects duplicates including escaped keys, deep JSON and oversized input, not brackets inside strings", () => {
    for (const raw of ['{"a":1,"\\u0061":2}', '{"nested":[{"a":1,"a":2}]}', '{"a":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}', ' '.repeat(1048577)]) expect(Either.isLeft(parseRequestJson(raw))).toBe(true);
    const input = request(); input.candidates[0]!.reason = 'brackets { [ \\" quoted';
    expect(Either.isRight(parseRequestJson(wire(input)))).toBe(true);
  });
  it("preserves urlsplit accepted spellings but rejects ports, dot segments, credentials and hostile origins", () => {
    for (const url of ["HTTPS://ARBEIDSPLASSEN.NAV.NO:/stillinger/stilling/one?#", " https://arbeidsplassen.nav.no/stillinger/stilling/one"]) expect(Either.isRight(parseRequest(request([{ ...candidate(), url }])))).toBe(true);

    for (const url of ["https://arbeidsplassen.nav.no:443/stillinger/stilling/one", "https://arbeidsplassen.nav.no/stillinger/stilling/../one", "https://user@arbeidsplassen.nav.no/stillinger/stilling/one", "https://evil.example/stillinger/stilling/one"]) expect(Either.isLeft(parseRequest(request([{ ...candidate(), url }])))).toBe(true);
  });
  it("reads requests through an injected Effect resource layer and propagates expected failures", async () => {
    const source = Layer.succeed(AssessmentRequests, { read: Effect.succeed(new TextEncoder().encode(wire())) });
    const program = Effect.flatMap(DigestSelection, (service) => service.select(now));
    expect((await Effect.runPromise(program.pipe(Effect.provide(DigestSelectionLive.pipe(Layer.provide(source)))))).status).toBe("ready");
    const failed = Layer.succeed(AssessmentRequests, { read: Effect.fail(new DigestInputError({ message: "unavailable" })) });
    expect(Either.isLeft(await Effect.runPromise(Effect.either(program.pipe(Effect.provide(DigestSelectionLive.pipe(Layer.provide(failed)))))))).toBe(true);
  });
});

describe("pulse_digest timestamp and validation boundaries", () => {
  it("preserves strict-after freshness boundaries down to one microsecond", () => {
    const parsed = Either.getOrThrow(parseRequest(request()));
    const checked = parsed.snapshot.checked_at;
    expect(Either.getOrThrow(selectDigest(parsed, now, { maxAgeMicros: now - checked })).status).toBe("ready");
    expect(Either.getOrThrow(selectDigest(parsed, now, { maxAgeMicros: now - checked - 1n })).blocked_reasons).toEqual(["source_stale"]);
    const future = { ...parsed, candidates: parsed.candidates.map((item) => ({ ...item, assessed_at: now + 1n })) };
    expect(Either.getOrThrow(selectDigest(future, now)).blocked_reasons).toEqual(["assessment_timestamp_in_future"]);
    const predates = { ...parsed, candidates: parsed.candidates.map((item) => ({ ...item, assessed_at: checked - 1n })) };
    expect(Either.getOrThrow(selectDigest(predates, now)).blocked_reasons).toEqual(["assessment_predates_snapshot"]);
    const expired = { ...parsed, candidates: parsed.candidates.map((item) => ({ ...item, expires_at: now })) };
    expect(Either.getOrThrow(selectDigest(expired, now)).status).toBe("quiet");

    for (const options of [{ maxCount: -1 }, { maxCount: 121 }, { maxCount: 1.5 }, { maxAgeMicros: 0n }, { maxAgeMicros: -1n }]) expect(Either.isLeft(selectDigest(parsed, now, options))).toBe(true);
  });
  it("rejects unsupported fields, duplicate names/pairs and invalid dates instead of narrowing inputs", () => {
    const input = request();

    const cases = [
      { ...input, extra: true }, { ...input, snapshot: { ...input.snapshot, extra: true } },
      { ...input, candidates: [{ ...candidate(), salary: "not a raw field" }] },
      { ...input, hard_constraints: ["location", "location"] },
      { ...input, delivered: [{ id: "one", version: "v1" }, { id: "one", version: "v1" }] },
      { ...input, candidates: [{ ...candidate(), expires_at: candidate().assessed_at }] },
      { ...input, snapshot: { ...input.snapshot, checked_at: "2026-10-17T11:50:00" } },
      { ...input, snapshot: { ...input.snapshot, checked_at: "2026-02-30T11:50:00Z" } },
      { ...input, include_market_only: 1 }, { ...input, profile_id: "a.b" },
      { ...input, profile_id: "owner\u2028" },
      { ...input, candidates: [{ ...candidate(), id: "one\u2028" }] },
      { ...input, candidates: [{ ...candidate(), url: candidate().url + "\u2028" }] },
      { ...input, profile_fingerprint: "A".repeat(64) },
      { ...input, candidates: [{ ...candidate(), uncertainties: Array.from({ length: 51 }, () => "point") }] },
      { ...input, candidates: [{ ...candidate(), reason: "bad\u0000text" }] },
    ];

    for (const value of cases) expect(Either.isLeft(parseRequest(value))).toBe(true);
    expect(Either.isRight(parseRequest({ ...input, profile_id: "Owner_1", candidates: [{ ...candidate(), reason: "line ending is normalized only before rejection" }] }))).toBe(true);
  });
});

describe("pulse_digest renderers", () => {
  it("distinguishes quiet, blocked and opted-in market context", () => {
    expect(Either.getOrThrow(renderText(run(request([]))))).toBe("Job market digest\n\nI did not find any relevant jobs this time.");
    const parsed = Either.getOrThrow(parseRequest(request([])));
    const digest = Either.getOrThrow(selectDigest({ ...parsed, market_context: "one\ntwo", include_market_only: true }, now));
    expect(digest.status).toBe("ready");
    expect(Either.getOrThrow(renderHtml(digest))).toContain("<li>one</li><li>two</li>");
    expect(Either.getOrThrow(renderText({ ...digest, status: "blocked", blocked_reasons: ["funnel_unverified"] }))).toContain("review store could not be read");
  });
  it("escapes markup, truncates Unicode summaries and rechecks directly constructed URLs", () => {
    const item = candidate(); item.title = '<img src=x> ' + "🐈 ".repeat(100); item.reason = '<script>alert("x")</script>'; item.uncertainties = Array.from({ length: 5 }, () => "Open point. ".repeat(20));
    const digest = run(request([item]));
    const output = Either.getOrThrow(digestJson(digest));
    expect(output.html).toContain("&lt;script&gt;"); expect(output.html).not.toContain("<img");
    expect(output.text).toContain("2 more omitted"); expect(output.text).toContain("…");
    expect(Either.getOrThrow(encodeDigestJson(digest))).toContain('"schema_version": 1');
    const hostile = { ...digest, candidates: [{ ...digest.candidates[0]!, url: "https://evil.example" }] };
    expect(Either.isLeft(renderText(hostile))).toBe(true); expect(Either.isLeft(renderHtml(hostile))).toBe(true);
  });
  it("independently reproduces all four recorded JSON/text/HTML boundaries", async () => {
    expect(await Effect.runPromise(compareDigestBoundaries.pipe(Effect.provide(BunFileSystem.layer)))).toHaveLength(4);
  });
});
