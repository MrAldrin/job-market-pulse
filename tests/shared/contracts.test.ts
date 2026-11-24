import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { boundedInteger, boundedText, ContractName, contractNames, decodeStrict, finiteNumber, header, validateRegistered } from "../../src/lib/contracts/support.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { pythonJson } from "../../src/lib/server/shared/python-json.ts";

const Product = Schema.Struct({ ...header("synthetic.contract", 1), text: boundedText(10) });
const decode = (text: string) => Either.flatMap(parseJsonInput(text), decodeStrict(Product));

describe("shared strict contract support", () => {
  it("validates raw header types, exact versions and unknown fields without numeric spelling collapse", () => {
    expect(decode('{"schema":"synthetic.contract","schema_version":1,"text":"value"}')).toEqual(Either.right({ schema: "synthetic.contract", schema_version: 1, text: "value" }));

    for (const version of ["true", "1.0", "1e0", '"1"', "2", "0", "-1"]) expect(Either.isLeft(decode('{"schema":"synthetic.contract","schema_version":' + version + ',"text":"value"}'))).toBe(true);

    for (const value of ['{"schema":"wrong","schema_version":1,"text":"value"}', '{"schema":"synthetic.contract","schema_version":1,"text":"value","extra":true}', '{"schema":"synthetic.contract","text":"value"}']) expect(Either.isLeft(decode(value))).toBe(true);
    const encoded = Schema.encodeEither(Product)({ schema: "synthetic.contract", schema_version: 1, text: "value" });
    expect(Either.isRight(encoded)).toBe(true);

    if (Either.isRight(encoded)) expect(pythonJson(encoded.right)).toBe('{"schema":"synthetic.contract","schema_version":1,"text":"value"}');
  });
  it("bounds Unicode code points, Python whitespace and finite numbers", () => {
    expect(Either.isRight(decodeStrict(boundedText(2))("🧭🧭"))).toBe(true);
    expect(Either.isLeft(decodeStrict(boundedText(1))("🧭🧭"))).toBe(true);
    expect(Either.isLeft(decodeStrict(boundedText())("\u001c\u0085"))).toBe(true);
    expect(Either.isRight(decodeStrict(boundedText())("\ufeff"))).toBe(true);
    expect(Either.isRight(decodeStrict(boundedText(1, true))(""))).toBe(true);

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, true, "1"]) expect(Either.isLeft(decodeStrict(finiteNumber)(value))).toBe(true);

    expect(Either.isRight(decodeStrict(boundedInteger(1, 10))(1n))).toBe(true);

    for (const value of [1, 0n, 11n, true]) expect(Either.isLeft(decodeStrict(boundedInteger(1, 10))(value))).toBe(true);
  });
  it("registers only retained contract names and invokes the supplied real validator", () => {
    expect(contractNames).toEqual(["assessment", "feedback_events", "snapshot"]);
    expect(Either.isLeft(decodeStrict(ContractName)("new-contract"))).toBe(true);
    const calls: string[] = [];

    const validator = (name: string) => (input: string) => { calls.push(name);

 return input === "valid" ? Either.right(input) : Either.left("Invalid contract"); };

    const validators = { assessment: validator("assessment"), feedback_events: validator("feedback_events"), snapshot: validator("snapshot") };
    expect(validateRegistered("snapshot", "valid", validators)).toEqual(Either.right("valid"));
    expect(validateRegistered("assessment", "invalid", validators)).toEqual(Either.left("Invalid contract"));
    expect(calls).toEqual(["snapshot", "assessment"]);
  });
});
