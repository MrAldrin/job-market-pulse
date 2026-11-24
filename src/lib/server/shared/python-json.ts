import { createHash } from "node:crypto";
import { Predicate } from "effect";

// Internal serialization type, not a wire wrapper. JS does not retain 25 vs 25.0.
export class PythonFloat {
  constructor(readonly value: number) {}
}

export type PythonJson = null | boolean | number | bigint | string | PythonFloat | readonly PythonJson[] | { readonly [key: string]: PythonJson };

export const codepointOrder = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);

  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);

    if (difference) return difference;
  }

  return a.length - b.length;
};

const quoted = (value: string, ascii: boolean): string => {
  const json = JSON.stringify(value);

  return ascii ? json.replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) : json;
};

// CPython repr uses scientific notation below 1e-4 and from 1e16, and a two-digit exponent.
export const pythonFloat = (value: number): string => {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value < 0 ? "-Infinity" : "Infinity";

  if (Object.is(value, -0)) return "-0.0";

  if (value === 0) return "0.0";

  const absolute = Math.abs(value);
  const raw = absolute < 0.0001 || absolute >= 1e16 ? value.toExponential() : value.toString();

  if (raw.includes("e")) {
    return raw.replace(/e([+-]?)([0-9]+)$/, (_, sign: string, exponent: string) => `e${sign || "+"}${exponent.padStart(2, "0")}`);
  }

  return raw.includes(".") ? raw : raw + ".0";
};

export const pythonJson = (value: PythonJson, ascii = true, pretty = false): string => {
  const visit = (item: PythonJson, depth: number): string => {
    if (item instanceof PythonFloat) return pythonFloat(item.value);

    if (Predicate.isBigInt(item)) return String(item);

    if (Predicate.isString(item)) return quoted(item, ascii);

    const indent = "  ".repeat(depth + 1);
    const end = "  ".repeat(depth);

    if (Array.isArray(item)) {
      const children = item.map((child) => visit(child, depth + 1));

      return children.length && pretty ? `[\n${indent}${children.join(",\n" + indent)}\n${end}]` : `[${children.join(",")}]`;
    }

    if (Predicate.isRecord(item)) {
      const children = Object.entries(item).sort(([a], [b]) => codepointOrder(a, b)).map(([key, child]) =>
        quoted(key, ascii) + (pretty ? ": " : ":") + visit(child, depth + 1),
      );

      return children.length && pretty ? `{\n${indent}${children.join(",\n" + indent)}\n${end}}` : `{${children.join(",")}}`;
    }

    return JSON.stringify(item);
  };

  return visit(value, 0) + (pretty ? "\n" : "");
};

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
