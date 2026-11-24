import { Effect, Predicate } from "effect";
import { codepointOrder, PythonFloat, type PythonJson, pythonJson } from "../../src/lib/server/shared/python-json.ts";
import type { SourceSql } from "../../src/lib/server/source/store.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encode = (value: PythonJson) => pythonJson(value, false, true);

// Capture every SQLite object and row; only primary-key ordering is normalized.
export const captureSourceDatabase = (sql: SourceSql) => Effect.gen(function* () {
  const schema = yield* sql<{ type: string; name: string; tbl_name: string; sql: string | null }>`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
  const tables: Record<string, PythonJson> = {};

  for (const object of schema.filter((item) => item.type === "table")) {
    const name = quote(object.name);
    const columns = yield* sql.unsafe<{ name: string; pk: number }>(`PRAGMA table_info(${name})`);
    const names = columns.map((column) => column.name);
    const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const expressions = names.flatMap((column, index) => [`${quote(column)} AS ${quote(`v${index}`)}`, `typeof(${quote(column)}) AS ${quote(`t${index}`)}`]);
    const rows = yield* sql.unsafe<Record<string, string | number | bigint | null | Uint8Array>>(`SELECT ${expressions.join(", ")} FROM ${name}`);

    const values = rows.map((row) => names.map((_column, index): PythonJson => {
      const value = row[`v${index}`];

      if (row[`t${index}`] === "real" && Predicate.isNumber(value)) return new PythonFloat(value);

      if (value === null || Predicate.isNumber(value) || Predicate.isBigInt(value) || Predicate.isString(value)) return value;

      if (value instanceof Uint8Array) return { $bytes_hex: Buffer.from(value).toString("hex") };
      throw new Error(`Unsupported SQLite value in ${object.name}`);
    }));

    const indices = primary.map((column) => names.indexOf(column));
    values.sort((a, b) => codepointOrder(encode(indices.length ? indices.map((index) => a[index]!) : a), encode(indices.length ? indices.map((index) => b[index]!) : b)));
    tables[object.name] = { sql: object.sql, columns: names, primary_key: primary, rows: values };
  }

  const version = yield* sql<{ user_version: number }>`PRAGMA user_version`;
  const integrity = yield* sql<Record<string, string>>`PRAGMA integrity_check`;
  const foreign = yield* sql<Record<string, PythonJson>>`PRAGMA foreign_key_check`;

  return encode({ present: true, user_version: version[0]!.user_version,
    integrity_check: integrity.map((row) => Object.values(row)), foreign_key_check: foreign.map((row) => Object.values(row)),
    schema_objects: schema.map((row) => [row.type, row.name, row.tbl_name, row.sql]), tables });
});
