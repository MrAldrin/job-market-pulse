import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either, Layer, Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { parseStrictContractBytes, parseStrictContractJson } from "../../src/lib/server/shared/strict-contract-json.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { readBoundedFile } from "../../src/lib/server/shared/bounded-file.ts";
import { FitReviewFiles, FitReviewFilesLive } from "../../src/lib/server/filter/review-service.ts";
import { AssessmentRequestsFile, DigestSelection, DigestSelectionLive } from "../../src/lib/server/select/service.ts";
import { parseRequestJson } from "../../src/lib/server/select/core.ts";
import { decodeReviewJson } from "../../src/lib/server/filter/review.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string) => parseStrictContractJson(text, 2_000_000);
const review = JSON.stringify({ schema_version: 1, profile_id: "REPLACE", manifest_id: "example", assessed_at: "2026-10-19T12:00:00Z", complete: true, assessments: [] });
const digest = JSON.stringify({ schema_version: 1, profile_id: "fixture", profile_fingerprint: "a".repeat(64), mode: "active", snapshot: { checked_at: "2026-10-19T12:00:00Z", caught_up: true }, assessments_complete: true, hard_constraints: [], candidates: [], delivered: [], market_context: "REPLACE" });

const readReview = (path: string) => Effect.flatMap(FitReviewFiles, (service) => service.read(path)).pipe(Effect.provide(FitReviewFilesLive.pipe(Layer.provide(BunFileSystem.layer))));
const readDigest = (path: string) => Effect.flatMap(DigestSelection, (service) => service.request).pipe(Effect.provide(DigestSelectionLive.pipe(Layer.provide(AssessmentRequestsFile(path)), Layer.provide(BunFileSystem.layer))));

describe("strict digest and fit-review JSON only", () => {
  it("rejects escaped duplicate keys without changing the B2 last-wins parser", () => {
    for (const text of ['{"a":1,"\\u0061":2}', '{"nested":{"🐈":1,"\\ud83d\\udc08":2}}', '{"a":[{"x":1,"x":2}]}']) {
      expect(Either.isLeft(parse(text))).toBe(true);
      expect(Either.isRight(parseJsonInput(text))).toBe(true);
    }

    expect(Either.isRight(parse('{"a":{"x":1},"b":{"x":2}}'))).toBe(true);
    expect(Either.isRight(parse('{"a":[1,2],"b":{"x":"[,{}]"}}'))).toBe(true);
  });

  it("counts original UTF-8 bytes and only containers outside strings toward depth", () => {
    const text = '{"x":"é"}';
    const length = bytes(text).byteLength;

    expect(Either.isRight(parseStrictContractJson(text, length))).toBe(true);
    expect(Either.isLeft(parseStrictContractJson(text, length - 1))).toBe(true);
    expect(Either.isRight(parse('{"x":' + "[".repeat(63) + "0" + "]".repeat(63) + "}"))).toBe(true);
    expect(Either.isLeft(parse('{"x":' + "[".repeat(64) + "0" + "]".repeat(64) + "}"))).toBe(true);
    expect(Either.isRight(parse(JSON.stringify({ x: "[".repeat(100) + "\\\"" + "}".repeat(100) })))).toBe(true);

    for (const invalid of ["[]", "1", "null", '{"x":"\ud800"}']) expect(Either.isLeft(parse(invalid))).toBe(true);
    expect(Either.isRight(parse('{"x":"\\ud800"}'))).toBe(true);
  });

  it("keeps prototype-like keys visible through both real consumer schemas", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const extra = ',"' + name + '":"extra"}';

      expect(Either.isLeft(parseRequestJson(digest.slice(0, -1) + extra))).toBe(true);
      expect(Either.isLeft(decodeReviewJson(review.slice(0, -1) + extra))).toBe(true);
    }

    const candidate = { id: "one", version: "v1", title: "Role", employer: "Example", url: "https://arbeidsplassen.nav.no/stillinger/stilling/one", fit: "strong", reason: "Example", assessed_at: "2026-10-19T12:00:00Z", expires_at: "2030-01-01T00:00:00Z", uncertainties: [] };
    const hostile = { ...candidate, hard_constraints: { ["__proto__"]: "pass" } };

    expect(Either.isLeft(parseRequestJson(digest.replace('"candidates":[]', '"candidates":[' + JSON.stringify(hostile) + ']')))).toBe(true);

    for (const name of ["constructor", "prototype"]) {
      const value = { ...candidate, hard_constraints: { [name]: "pass" } };
      const text = digest.replace('"hard_constraints":[]', '"hard_constraints":["' + name + '"]').replace('"candidates":[]', '"candidates":[' + JSON.stringify(value) + ']');
      const parsed = Either.getOrThrow(parseRequestJson(text));

      expect(Object.hasOwn(parsed.candidates[0]?.hard_constraints ?? {}, name)).toBe(true);
    }

    const version = { ["__proto__"]: { echo: "kept" }, constructor: 1, prototype: 2 };
    const assessment = { id: "one", version, fit: "possible", reason: "Example", evidence: [], uncertainties: [], hard_constraints: "unknown", ad_text_reviewed: false };
    const parsed = Either.getOrThrow(decodeReviewJson(review.replace('"assessments":[]', '"assessments":[' + JSON.stringify(assessment) + ']')));
    const echoed = parsed.assessments[0]?.version;

    expect(Predicate.isRecord(echoed)).toBe(true);

    if (Predicate.isRecord(echoed)) {
      expect(Object.hasOwn(echoed, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(echoed)).toBe(Object.prototype);
    }
  });

  it("rejects malformed UTF-8 and BOM before either real filesystem consumer can replace or strip bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pulse-contract-bytes-"));
    const path = join(directory, "input.json");

    try {
      for (const [document, read] of [[review, (file: string) => readReview(file).pipe(Effect.either, Effect.map(Either.isRight))], [digest, (file: string) => readDigest(file).pipe(Effect.either, Effect.map(Either.isRight))]] as const) {
        writeFileSync(path, bytes(document));
        expect(await Effect.runPromise(read(path))).toBe(true);
        const [prefix = "", suffix = ""] = document.split("REPLACE");

        for (const invalid of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xf0, 0x80, 0x80, 0x80)]) {
          const payload = Buffer.concat([bytes(prefix), invalid, bytes(suffix)]);
          writeFileSync(path, payload);
          expect(await Effect.runPromise(read(path))).toBe(false);
        }

        const bom = Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), bytes(document)]);
        writeFileSync(path, bom);
        expect(await Effect.runPromise(read(path))).toBe(false);
      }

      writeFileSync(path, new Uint8Array(2_000_010));
      const bounded = await Effect.runPromise(readBoundedFile(path, 2_000_000).pipe(Effect.provide(BunFileSystem.layer)));

      expect(bounded.byteLength).toBe(2_000_001);
      expect(Either.isLeft(parseStrictContractBytes(bounded, 2_000_000))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
