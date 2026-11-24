import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import { checkProtocolAttempt, countProtocolSkips, encodeProtocolLine, parseProtocolLine, PROTOCOL_LINE_MAX_BYTES } from "../../src/lib/server/judge/protocol.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string) => Effect.runSync(Effect.either(parseProtocolLine(bytes(text))));

describe("judge protocol", () => {
  it("accepts typed records and rejects unknown keys, duplicate keys and multiple lines", () => {
    expect(Either.isRight(parse('{"type":"retry","attempt_id":"a"}\n'))).toBe(true);

    for (const text of ['{"type":"retry","attempt_id":"a","extra":1}', '{"type":"retry","type":"retry","attempt_id":"a"}', '{}\n{}', '[]', '']) expect(Either.isLeft(parse(text))).toBe(true);
  });
  it("enforces byte limits and UTF-8", () => {
    expect(Either.isLeft(Effect.runSync(Effect.either(parseProtocolLine(new Uint8Array([255])))))).toBe(true);
    expect(Either.isLeft(parse(' '.repeat(PROTOCOL_LINE_MAX_BYTES + 1)))).toBe(true);
    expect(Either.isLeft(Effect.runSync(Effect.either(encodeProtocolLine({ text: 'é'.repeat(PROTOCOL_LINE_MAX_BYTES / 2) }))))).toBe(true);
    expect(new TextDecoder().decode(Effect.runSync(encodeProtocolLine({ type: 'ready' })))).toBe('{"type":"ready"}\n');
  });
  it("preserves integer-token usage and rejects negative or overbound telemetry", () => {
    for (const usage of ['"input_tokens":1.0', '"output_tokens":1e0', '"input_tokens":-1', '"output_tokens":1000001', '"wall_time_seconds":-0.1']) {
      expect(Either.isLeft(parse(`{"type":"result","attempt_id":"a","raw_result":"{}",${usage}}`))).toBe(true);
    }

    expect(Either.getOrThrow(parse('{"type":"result","attempt_id":"a","raw_result":"{}","input_tokens":1000000,"wall_time_seconds":1}'))).toMatchObject({ input_tokens: 1000000, wall_time_seconds: 1 });
    expect(Either.isRight(parse('{"type":"unknown","attempt_id":"a","wall_time_seconds":0.5,"input_tokens":null}'))).toBe(true);
  });
  it("counts a JSONL input terminator in the frozen byte limit", () => {
    const prefix = '{"type":"result","attempt_id":"a","raw_result":"';
    const suffix = '"}';
    const line = prefix + "x".repeat(PROTOCOL_LINE_MAX_BYTES - prefix.length - suffix.length) + suffix;
    expect(Either.isRight(parse(line))).toBe(true);
    expect(Either.isLeft(parse(line + "\n"))).toBe(true);
  });
  it("checks attempts", () => {
    expect(Either.isLeft(Effect.runSync(Effect.either(checkProtocolAttempt({ attempt_id: 'a' }, 'b'))))).toBe(true);
  });
  it("counts latest attempt once per distinct skipped candidate", () => {
    expect(countProtocolSkips([{ listing_id: 'a', status: 'pending' }, { listing_id: 'b', status: 'completed' }], new Set(['a', 'b']), [{ candidate_ids: ['a'], status: 'failed' }, { candidate_ids: ['a'], status: 'unknown', error_code: 'detail_inactive' }])).toEqual({ not_reviewed_count: 1, skip_inactive_count: 1, skip_changed_count: 0, skip_text_count: 0, skip_failed_count: 0, skip_other_count: 0 });
  });
});
