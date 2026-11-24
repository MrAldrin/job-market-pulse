import { expect, test } from "vitest";
import { diagnostic, redactedExcerpt, validatorCode } from "../../src/lib/server/judge/diagnostics.ts";
import { PythonFloat } from "../../src/lib/server/shared/python-json.ts";

test("diagnostics preserve reply shape and insertion order, not model text", () => {
  const raw = '{"schema_version":1,"assessments":[{"id":"invented-listing","fit":"strong","reason":"invented-contact@example.invalid"}],"complete":true,"extra":"private invented text"}';

  expect(redactedExcerpt(raw)).toBe('{"schema_version":"[REDACTED]","assessments":[{"id":"[REDACTED]","fit":"strong","reason":"[REDACTED]"}],"complete":true,"[KEY_3]":"[REDACTED]"}');
});

test("diagnostics keep bounded usage and fixed vocabulary separately from reply text", () => {
  expect(diagnostic({ text: '{"reason":"lønn"}', branch: "accepted", metadata: { input_tokens: 100n, output_tokens: 50, cost_usd: new PythonFloat(0.25), stop_reason: "end_turn", partial: true } })).toEqual({
    branch: "accepted", validation_check: null, stop_reason: "end_turn", answer_chars: 17, answer_bytes: 18,
    input_tokens: 100, output_tokens: 50, cost_usd: new PythonFloat(0.25), partial: true, excerpt: '{"reason":"[REDACTED]"}',
  });

  expect(diagnostic({ metadata: { excerpt: "invented private prose", stop_reason: "invented-contact@example.invalid", input_tokens: true }, branch: "invented private prose", check: "invented private prose" })).toMatchObject({
    branch: "unknown", validation_check: null, stop_reason: null, input_tokens: null, excerpt: "[REDACTED malformed/prose text]",
  });
  expect(validatorCode(new Error("Unexpected title-screen schema"))).toBe("screen_schema");
  expect(validatorCode(new Error("Invalid assessment time"))).toBe("assessment_timestamp");
  expect(validatorCode(new Error("untrusted model text"))).toBe("validator_other");
});

test("a realistic large full-review batch cannot create an unbounded excerpt", () => {
  const assessment = { id: "invented-listing", version: "2026-10-19T10:00:00Z", fit: "possible", reason: "invented private detail", evidence: ["invented private detail"], uncertainties: ["invented private detail"], hard_constraints: "unknown", ad_text_reviewed: true };
  const excerpt = redactedExcerpt(JSON.stringify({ assessments: Array.from({ length: 40 }, () => assessment) }));

  expect(excerpt).toHaveLength(4096);
  expect(excerpt).not.toContain("invented private detail");
  expect(diagnostic({ metadata: { excerpt } }).excerpt).toBe("[REDACTED malformed/prose text]");
});
