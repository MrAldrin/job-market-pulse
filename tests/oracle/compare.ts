import { FileSystem } from "@effect/platform";
import { Data, Effect, Predicate, Schema } from "effect";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const JsonValue: Schema.Schema<Json> = Schema.suspend(() => Schema.Union(
  Schema.Null, Schema.Boolean, Schema.Number.pipe(Schema.finite()), Schema.String,
  Schema.Array(JsonValue), Schema.Record({ key: Schema.String, value: JsonValue }),
));

// Python sorts Unicode code points, not JavaScript's UTF-16 code units.
const keyOrder = (a: string, b: string): number => {
  const left = Array.from(a, (character) => character.codePointAt(0) ?? 0);
  const right = Array.from(b, (character) => character.codePointAt(0) ?? 0);

  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference) return difference;
  }

  return left.length - right.length;
};

// Match record/support.py without JS integer-key reordering. Input is decoded JSON.
const format = (value: Json, depth: number): string => {
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);

  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((child) => indent + format(child, depth + 1)).join(",\n")}\n${closeIndent}]` : "[]";
  }

  if (Predicate.isRecord(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => keyOrder(a, b));

    return entries.length ? `{\n${entries.map(([key, child]) => indent + JSON.stringify(key) + ": " + format(child, depth + 1)).join(",\n")}\n${closeIndent}}` : "{}";
  }

  return JSON.stringify(value);
};

export const encode = (value: Json): string => format(value, 0) + "\n";

// Caller supplies its validated declared PK values, in order. Default: keyless row.
export const sortRows = <A extends readonly Json[]>(rows: readonly A[], key: (row: A) => Json = (row) => row): readonly A[] =>
  rows.toSorted((a, b) => keyOrder(encode(key(a)), encode(key(b))));

export const shortDiff = (expected: string, actual: string): string => {
  const left = expected.split("\n");
  const right = actual.split("\n");
  const index = left.findIndex((line, n) => line !== right[n]);
  const at = index < 0 ? left.length : index;

  return `line ${at + 1}\n- ${left[at] ?? "<EOF>"}\n+ ${right[at] ?? "<EOF>"}`;
};

export class OracleMismatch extends Data.TaggedError("OracleMismatch")<{
  readonly path: string;
  readonly diff: string;
}> {}

// Expected bytes remain intact, including numeric spellings, whitespace and timestamps.
export const compareText = (path: string, actual: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const expected = yield* fs.readFileString(path);

  if (expected !== actual) {
    return yield* new OracleMismatch({ path, diff: shortDiff(expected, actual) });
  }
});

export const compareJson = (path: string, actual: Json) =>
  Schema.decodeUnknown(JsonValue)(actual).pipe(Effect.flatMap((value) => compareText(path, encode(value))));
