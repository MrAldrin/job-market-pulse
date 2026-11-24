import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { parseTaxonomy } from "../../src/lib/server/market/taxonomy.ts";

// Generic classifier inputs for the frozen synthetic Market replay. This file
// is not installed as a runtime default.
const path = fileURLToPath(new URL("../fixtures/port-oracle/market-history/inputs/market_taxonomy.toml", import.meta.url));
export const fixtureTaxonomyText = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));
export const fixtureTaxonomy = fixtureTaxonomyText.pipe(Effect.flatMap(parseTaxonomy));
