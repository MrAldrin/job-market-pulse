import { Either, Option, Schema } from "effect";
import { parseIsoTime } from "./iso-time.ts";
import { strip } from "../text-whitespace.ts";

// Schemas are the boundary authority. Pure callers use Either; services lift it to Effect.
export const decodeStrict = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" });

export const finiteNumber = Schema.Number.pipe(Schema.finite());
export const nonemptyText = Schema.String.pipe(Schema.filter((text) => strip(text).length > 0));
export const nonemptyTextList = Schema.Array(nonemptyText);

export const boundedText = (maximum = 2000, allowEmpty = false) => Schema.String.pipe(
  Schema.filter((text) => (allowEmpty || strip(text).length > 0) && Array.from(text).length <= maximum),
);

// JSON/TOML readers retain integer lexical tokens as bigint. A floating token
// such as 1.0 or 1e0 must not pass Python's integer-only boundary.
export const integerToken = Schema.transform(
  Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER))),
  Schema.Int, { strict: true, decode: Number, encode: BigInt },
);

export const boundedInteger = (minimum = 0, maximum = 10_000_000) => integerToken.pipe(Schema.between(minimum, maximum));

// Preserve offset text; do not infer the host zone for a naive timestamp.
export const awareTimestamp = boundedText().pipe(Schema.filter((text) =>
  Option.exists(parseIsoTime(text), (time) => time.aware),
));

export const header = <Name extends string, Version extends number>(name: Name, version: Version) => ({
  schema: Schema.Literal(name),
  schema_version: Schema.compose(integerToken, Schema.Literal(version)),
});

// Registration is explicit. Later brick owners supply their real validators, never placeholders.
export const contractNames = ["assessment", "feedback_events", "snapshot"] as const;
export const ContractName = Schema.Literal(...contractNames);

export type ContractName = typeof ContractName.Type;

export const validateRegistered = <A>(name: ContractName, value: A, validators: Readonly<Record<ContractName, (input: A) => Either.Either<A, string>>>) =>
  validators[name](value);
