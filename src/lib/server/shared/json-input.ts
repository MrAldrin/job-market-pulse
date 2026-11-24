import { Either, Predicate, Schema } from "effect";
import { ProfileError } from "../profile/errors.ts";

export type JsonObject = { readonly [key: string]: JsonInput };

export type JsonInput = null | boolean | number | bigint | string | readonly JsonInput[] | JsonObject;

// Validate dictionaries without assigning their keys into a new object's setters.
export const JsonObject: Schema.Schema<JsonObject> = Schema.declare<JsonObject>((value): value is JsonObject =>
  Predicate.isRecord(value) && Object.values(value).every(Schema.is(JsonInput)),
);

export const JsonInput: Schema.Schema<JsonInput> = Schema.suspend(() => Schema.Union(
  Schema.Null, Schema.Boolean, Schema.String, Schema.Number, Schema.BigIntFromSelf,
  Schema.Array(JsonInput), JsonObject,
));

// Bun 1.4.4 and the test runtime expose ES2026 reviver context.source. Keep raw number
// types: Python integer validators refuse 1.0 and 1e0, even though Number is integral.
export const reviveJsonNumber = <A>(_key: string, value: A, context?: { readonly source?: string }): A | bigint => {
  if (Predicate.isNumber(value) && context?.source && /^-?[0-9]+$/.test(context.source)) {
    return BigInt(context.source);
  }

  return value;
};

export const parseJsonInput = (text: string) => Either.flatMap(Either.try({
  try: () => {
    const raw: unknown = JSON.parse(text, reviveJsonNumber);

    return Schema.is(JsonInput)(raw) ? Either.right(raw) : Either.left(new ProfileError({ message: "Invalid JSON input" }));
  },
  catch: () => new ProfileError({ message: "Invalid JSON input" }),
}), (parsed) => parsed);
