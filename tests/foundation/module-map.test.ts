import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";

const entry = Schema.Struct({ brick: Schema.NonEmptyString, role: Schema.NonEmptyString });
const mapSchema = Schema.Struct({ typescript_modules: Schema.Record({ key: Schema.String, value: entry }) });

const walk = async (directory: string): Promise<string[]> => {
  const files: string[] = [];

  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);

    if (item.isDirectory()) files.push(...await walk(path));
    else if (item.isFile() && path.endsWith(".ts")) files.push(path);
  }

  return files;
};

test("new server, contract and CLI files cannot bypass the ownership map", async () => {
  // Exercise Bun's TOML parser without adding a test-only parsing dependency.
  const document = execFileSync("bun", ["-e", 'console.log(JSON.stringify(Bun.TOML.parse(await Bun.file("docs/architecture/module-map.toml").text())))'], { encoding: "utf8" });
  const map = Schema.decodeUnknownSync(Schema.parseJson(mapSchema))(document);
  const paths: string[] = [];

  for (const directory of ["src/lib/server", "src/lib/contracts", "src/cli"]) paths.push(...await walk(directory));

  expect(Object.keys(map.typescript_modules).sort()).toEqual(paths.map((path) => path.split(sep).join("/")).sort());
});
