import { Either, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { parseMatches } from "../../src/lib/server/profile/place-lookup.ts";
import { JsonInput, JsonObject, parseJsonInput, reviveJsonNumber } from "../../src/lib/server/shared/json-input.ts";

const parse = (text: string) => Either.getOrThrow(parseJsonInput(text));
const object = Schema.decodeUnknownSync(JsonObject);

describe("native JSON own-key boundary", () => {
  it("does not turn JSON data into inherited required fields", () => {
    const raw = object(parse('{"__proto__":{"required":"inherited"}}'));
    expect(Object.hasOwn(raw, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
    expect(Object.keys(raw)).toEqual(["__proto__"]);
    expect(raw.required).toBeUndefined();
    expect(Either.isLeft(decodeStrict(Schema.Struct({ required: Schema.String }))(raw))).toBe(true);
    expect(Schema.decodeUnknownSync(JsonInput)(raw)).toBe(raw);
    expect(object(raw)).toBe(raw);
    expect(Object.hasOwn(Object.prototype, "required")).toBe(false);
  });

  it("preserves native own keys at nested object and array boundaries without a key ban", () => {
    fc.assert(fc.property(fc.constantFrom("__proto__", "constructor", "prototype", "ordinary"), fc.jsonValue(), (key, value) => {
      const text = JSON.stringify({ items: [Object.fromEntries([[key, value]])] });
      const parsed = object(parse(text));
      const native = JSON.parse(text, reviveJsonNumber);
      expect(parsed).toEqual(native);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      const items = parsed.items;
      expect(Array.isArray(items)).toBe(true);

      if (!Array.isArray(items)) throw new Error("Expected synthetic array");
      const row = object(items[0]);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.hasOwn(row, key)).toBe(true);
      expect(Object.keys(row)).toEqual([key]);
    }));
    const duplicate = object(parse('{"__proto__":{"old":true},"__proto__":{"new":true},"constructor":null,"prototype":0}'));
    expect(duplicate.__proto__).toEqual({ new: true });
    expect(duplicate.constructor).toBeNull();
    expect(duplicate.prototype).toBe(0n);
  });

  it("keeps Profile provider schemas strict on required own fields, but allows inert extra data", () => {
    for (const text of ['{"__proto__":{"metadata":{"totaltAntallTreff":0},"navn":[]}}', '{"metadata":{"__proto__":{"totaltAntallTreff":0}},"navn":[]}']) {
      expect(Either.isLeft(parseMatches(parse(text)))).toBe(true);
    }

    expect(parseMatches(parse('{"metadata":{"totaltAntallTreff":0,"__proto__":{"ignored":true}},"navn":[],"constructor":null,"prototype":0}'))).toEqual(Either.right([]));
  });
});
