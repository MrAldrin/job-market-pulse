import { Data, Either, Predicate, Schema } from "effect";
import { JsonInput, reviveJsonNumber } from "./json-input.ts";

export class StrictContractJsonError extends Data.TaggedError("StrictContractJsonError")<{ readonly message: string }> {}

const invalid = () => new StrictContractJsonError({ message: "Invalid bounded contract JSON" });

// Digest and supplied fit reviews share the frozen bounded, unique-key object
// contract. NAV/Profile deliberately keep parseJsonInput's existing policy.
const uniqueAndBounded = (text: string): boolean => {
  const stack: ({ readonly keys: Set<string>; key: boolean } | null)[] = [];

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (character === '"') {
      const start = index;

      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }

      const frame = stack.at(-1);

      if (frame?.key) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));

        if (!Predicate.isString(key) || frame.keys.has(key)) return false;
        frame.keys.add(key);
        frame.key = false;
      }
    } else if (character === "{" || character === "[") {
      stack.push(character === "{" ? { keys: new Set(), key: true } : null);

      if (stack.length > 64) return false;
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === ",") {
      const frame = stack.at(-1);

      if (frame) frame.key = true;
    }
  }

  return true;
};

export const parseStrictContractJson = (text: string, maxBytes: number) => Either.gen(function* () {
  if (!text.isWellFormed() || new TextEncoder().encode(text).byteLength > maxBytes) return yield* Either.left(invalid());
  const valid = yield* Either.try({ try: () => uniqueAndBounded(text), catch: invalid });

  if (!valid) return yield* Either.left(invalid());

  // Validate without replacing the native object: the B2 Schema.Record decode
  // currently loses own __proto__ keys. Its parser is deliberately unchanged.
  const parsed = yield* Either.try({ try: () => {
    const value: unknown = JSON.parse(text, reviveJsonNumber);

    return Schema.is(JsonInput)(value) && Predicate.isRecord(value) ? Either.right(value) : Either.left(invalid());
  }, catch: invalid });

  return yield* parsed;
});

export const parseStrictContractBytes = (bytes: Uint8Array, maxBytes: number) => Either.gen(function* () {
  if (bytes.byteLength > maxBytes) return yield* Either.left(invalid());
  // ignoreBOM:true preserves U+FEFF so JSON rejects it, like utf-8 (not utf-8-sig).
  const text = yield* Either.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), catch: invalid });

  return yield* parseStrictContractJson(text, maxBytes);
});
