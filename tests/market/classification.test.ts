import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Scope } from "effect";
import fc from "fast-check";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MarketAd } from "../../src/lib/contracts/market.ts";
import { classifyDetail, countSnapshot, techTotal, titlesOnly, uniqueAds, unknownTitleWordCounts } from "../../src/lib/server/market/core.ts";
import { loadTaxonomy, parseTaxonomy, type Taxonomy } from "../../src/lib/server/market/taxonomy.ts";
import { fixtureTaxonomy, fixtureTaxonomyText } from "./fixture-taxonomy.ts";

const run = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunContext.layer)));

const syntheticRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-market-taxonomy-" });
  const directory = join(root, "local_only", "config");
  yield* fs.makeDirectory(directory, { recursive: true });

  return { root, local: join(directory, "market_taxonomy.toml") };
});

const ad = (uuid: string, title: string, text = ""): MarketAd => ({ uuid, title, text, published: "", employer: "", municipality: "", occupations: "" });

const tax: Taxonomy = {
  version: "synthetic", enabled: true, text_min_hits: 2, title_exclusions: [/phd/i],
  families: [
    { key: "data_science", label: "Data science", title: [/scientist/i], text: [/python/i, /statistics/i] },
    { key: "data_engineering", label: "Data engineering", title: [/engineer/i], text: [/sql/i, /pipeline/i] },
    { key: "mixed_data", label: "Mixed data", title: [/data role/i], text: [] },
  ],
  terms: [{ group: "language", label: "Python", key: "language/Python", pattern: /python/i }],
};

describe("market classification", () => {
  it("uses title precedence, mixed titles, text ties and fallback", () => {
    expect(classifyDetail(ad("1", "scientist engineer"), tax)).toEqual({ family: "mixed_data", method: "mixed-title" });
    expect(classifyDetail(ad("1", "data role"), tax)).toEqual({ family: "mixed_data", method: "generic-title" });
    expect(classifyDetail(ad("1", "other", "python statistics"), tax)).toEqual({ family: "data_science", method: "text" });
    expect(classifyDetail(ad("1", "other", "python"), tax)).toEqual({ family: "other", method: "none" });
    const tieTax = { ...tax, families: tax.families.map((family) => family.key === "data_engineering" ? { ...family, key: "software" } : family) };
    expect(classifyDetail(ad("1", "scientist engineer", "sql"), tieTax)).toEqual({ family: "software", method: "title-tie" });
    expect(classifyDetail(ad("1", "scientist engineer"), tieTax).family).toBe("data_science");
  });
  it("counts excluded terms but not as tech, and blanks title-only fields", () => {
    const rows = [ad("a", "PhD scientist", "python"), ad("b", "scientist", "python")];
    const counts = countSnapshot(rows, tax);
    expect(counts.terms["language/Python"]).toBe(2);
    expect(counts.tech_terms["language/Python"]).toBe(1);
    expect(techTotal(counts.families)).toBe(1);
    expect(titlesOnly(rows)[0]?.text).toBe("");
  });
  it("minimizes unknown words once per unique ad", () => {
    expect(unknownTitleWordCounts([ad("a", "Senior Quantum Quantum Scientist"), ad("a", "discarded"), ad("", "Quantum"), ad("", "Quantum")], tax)).toEqual({ quantum: 3 });
  });
  it("deduplicates only nonempty UUIDs and partitions counts", () => {
    fc.assert(fc.property(fc.array(fc.record({ uuid: fc.constantFrom("", "a", "b"), title: fc.constantFrom("scientist", "engineer", "unknown") })), (input) => {
      const rows = input.map(({ uuid, title }) => ad(uuid, title));
      const unique = uniqueAds(rows);
      const counts = countSnapshot(rows, tax);
      expect(counts.ad_count).toBe(unique.length);
      expect(Object.values(counts.families).reduce((sum, value) => sum + value, 0)).toBe(unique.length);
      expect(techTotal(counts.families) + (counts.families.other ?? 0)).toBe(unique.length);
    }));
  });
  it.each([1, 3])("accepts positive integer text_min_hits %s", (hits) => {
    const result = Either.getOrThrow(parseTaxonomy(`[settings]\nenabled = false\ntext_min_hits = ${hits}\n`));
    expect(result.text_min_hits).toBe(hits);
  });
  it.each(["0", "-1", "2.0", "2e0", "true", '"2"', "[2]"])("rejects non-positive or non-integer text_min_hits %s", (token) => {
    expect(Either.isLeft(parseTaxonomy(`[settings]\nenabled = false\ntext_min_hits = ${token}\n`))).toBe(true);
  });
  it.each([
    'unexpected = true\n[settings]\nenabled = false\n',
    '[settings]\nenabled = false\nunexpected = true\n',
    '[settings]\nenabled = false\n[[families]]\nkey = "design"\nlabel = "Design"\ntitle = ["designer"]\nunexpected = true\n',
    '[settings]\nenabled = false\n[[terms]]\ngroup = "tools"\nlabel = "Figma"\npattern = "figma"\nunexpected = true\n',
  ])("rejects unknown taxonomy fields in %s", (text) => {
    expect(Either.isLeft(parseTaxonomy(text))).toBe(true);
  });
  it("accepts disabled settings and rejects invalid TOML and regex", () => {
    const disabled = parseTaxonomy("[settings]\nenabled = false\n");
    expect(Either.isRight(disabled) && disabled.right.enabled).toBe(false);
    expect(Either.isLeft(parseTaxonomy("[settings"))).toBe(true);
    expect(Either.isLeft(parseTaxonomy('[settings]\nenabled = false\n\n[[terms]]\ngroup = "x"\nlabel = "y"\npattern = "["\n'))).toBe(true);
  });
});

describe("market taxonomy loading", () => {
  it("loads tracked rules by default and for a root without an override", async () => run(Effect.gen(function* () {
    const { root } = yield* syntheticRoot;
    const tracked = yield* loadTaxonomy();
    const fallback = yield* loadTaxonomy(root);
    expect(tracked).toMatchObject({ version: "disabled", enabled: false, families: [], terms: [] });
    expect(fallback).toEqual(tracked);
  })));

  it("classifies realistic Norwegian and English titles with the historical fixture", async () => run(Effect.gen(function* () {
    const tracked = yield* fixtureTaxonomy;

    const cases = [
      ["Grafisk designer", "design", "title"],
      ["Senior dataviter", "data_science", "title"],
      ["Data Engineer", "data_engineering", "title"],
      ["Forretningsanalytiker", "analytics_bi", "title"],
      ["MLOps Engineer", "ai_infrastructure", "title"],
      ["Machine Learning Engineer", "ml_ai_engineering", "title"],
      ["Systemutvikler", "software_development", "title"],
      ["Dataforvalter", "mixed_data", "generic-title"],
      ["PhD Data Scientist", "other", "excluded-title"],
      ["Sykepleier", "other", "none"],
    ] as const;

    for (const [title, family, method] of cases) {
      expect(classifyDetail(ad("synthetic", title), tracked)).toEqual({ family, method });
    }

    expect(classifyDetail(ad("fallback", "Teknisk konsulent", "dbt Airflow"), tracked)).toEqual({ family: "data_engineering", method: "text" });
    expect(classifyDetail(ad("below-threshold", "Teknisk konsulent", "dbt"), tracked)).toEqual({ family: "other", method: "none" });
    expect(classifyDetail(ad("tie", "ML Software Engineer", "Python PyTorch"), tracked)).toEqual({ family: "ml_ai_engineering", method: "title-tie" });
  })));

  it("counts Norwegian compound titles without leaving partial words", async () => run(Effect.gen(function* () {
    const tracked = yield* fixtureTaxonomy;
    const ads = [ad("native-data", "Dataingeniører"), ad("native-ml", "maskinlæringsløsninger")];
    const counts = countSnapshot(ads, tracked);
    expect(counts.families.data_engineering).toBe(1);
    expect(counts.families.ml_ai_engineering).toBe(1);
    expect(counts.terms["data/Data engineering"]).toBe(1);
    expect(counts.terms["ai/Machine learning"]).toBe(1);
    expect(counts.tech_terms["ai/Machine learning"]).toBe(1);
    expect(unknownTitleWordCounts(ads, tracked)).toEqual({});
  })));

  it("reloads a changed local version and then disabled settings without caching", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, local } = yield* syntheticRoot;
    const compatibilityText = yield* fixtureTaxonomyText;
    const legacy = yield* fixtureTaxonomy;
    yield* fs.writeFileString(local, compatibilityText);
    expect(legacy.version).toBe("2026.10-v5");
    expect(yield* loadTaxonomy(root)).toEqual(legacy);
    yield* fs.writeFileString(local, compatibilityText.replace(`version = "${legacy.version}"`, 'version = "synthetic-override"'));
    const override = yield* loadTaxonomy(root);
    expect(override.version).toBe("synthetic-override");
    expect(override.enabled).toBe(true);
    expect(classifyDetail(ad("a", "Data Scientist"), override)).toEqual({ family: "data_science", method: "title" });
    yield* fs.writeFileString(local, "[settings]\nenabled = false\n");
    const disabled = yield* loadTaxonomy(root);
    expect(disabled.version).toBe("disabled");
    expect(disabled.enabled).toBe(false);
    expect(classifyDetail(ad("a", "Data Scientist"), disabled)).toEqual({ family: "other", method: "disabled" });
  })));

  it.each(["[settings", 'version = "incomplete"\n', "[settings]\nenabled = false\nunexpected = true\n"])("fails an invalid local override without falling back: %s", async (text) => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, local } = yield* syntheticRoot;
    yield* fs.writeFileString(local, text);
    const result = yield* Effect.either(loadTaxonomy(root));
    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) expect(result.left.message).toBe("Invalid market taxonomy");
  })));

  it("fails a broken local symlink instead of using tracked rules", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, local } = yield* syntheticRoot;
    yield* fs.symlink(join(root, "missing-taxonomy.toml"), local);
    const result = yield* Effect.either(loadTaxonomy(root));
    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) expect(result.left.message).toBe("Cannot read market taxonomy");
  })));
});
