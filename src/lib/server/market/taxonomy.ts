import { FileSystem } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { checkedInstallationSetting, packageConfigPath } from "../shared/paths.ts";
import { integerToken, nonemptyText } from "../../contracts/support.ts";
import { strip } from "../shared/text.ts";
import { parseToml } from "../shared/toml.ts";
import { MarketError } from "./errors.ts";

export type Taxonomy = {
  readonly version: string;
  readonly text_min_hits: number;
  readonly families: readonly { readonly key: string; readonly label: string; readonly title: readonly RegExp[]; readonly text: readonly RegExp[] }[];
  readonly terms: readonly { readonly group: string; readonly label: string; readonly pattern: RegExp; readonly key: string }[];
  readonly title_exclusions: readonly RegExp[];
  readonly enabled: boolean;
};

const strings = Schema.Array(Schema.String);
const family = Schema.Struct({ key: nonemptyText, label: nonemptyText, title: Schema.optional(strings), text: Schema.optional(strings) });
const term = Schema.Struct({ group: nonemptyText, label: nonemptyText, pattern: nonemptyText });

const config = Schema.Struct({
  version: Schema.optional(nonemptyText), excluded_titles: Schema.optional(strings),
  settings: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean), text_min_hits: Schema.optional(integerToken.pipe(Schema.greaterThanOrEqualTo(1))) })),
  families: Schema.optional(Schema.Array(family)), terms: Schema.optional(Schema.Array(term)),
});

const required = ["design", "data_science", "data_engineering", "analytics_bi", "ai_infrastructure", "ml_ai_engineering", "software_development", "mixed_data"];
const invalid = () => new MarketError({ message: "Invalid market taxonomy" });

const compilePattern = (source: string): RegExp => new RegExp(source, "i");

export const parseTaxonomy = (text: string): Either.Either<Taxonomy, MarketError> => Either.gen(function* () {
  const raw = yield* Either.mapLeft(parseToml(text), invalid);
  const data = yield* Either.mapLeft(Schema.decodeUnknownEither(config, { onExcessProperty: "error" })(raw), invalid);
  const enabled = data.settings?.enabled ?? true;

  if (enabled && data.version === undefined) return yield* Either.left(invalid());
  const seen = new Set<string>();

  for (const item of data.families ?? []) {
    const key = strip(item.key);

    if (!/^[a-z_]+$/.test(key) || key === "other" || seen.has(key) || !item.title?.length) return yield* Either.left(invalid());
    seen.add(key);
  }

  if (enabled && required.some((key) => !seen.has(key))) return yield* Either.left(invalid());
  const termKeys = new Set<string>();

  for (const item of data.terms ?? []) {
    const key = `${strip(item.group)}/${strip(item.label)}`;

    if (termKeys.has(key)) return yield* Either.left(invalid());
    termKeys.add(key);
  }

  return yield* Either.try({
    try: () => ({
      version: data.version === undefined ? "disabled" : strip(data.version), enabled,
      text_min_hits: data.settings?.text_min_hits ?? 2,
      families: (data.families ?? []).map((item) => ({ key: strip(item.key), label: strip(item.label), title: (item.title ?? []).map(compilePattern), text: (item.text ?? []).map(compilePattern) })),
      terms: (data.terms ?? []).map((item) => ({ group: strip(item.group), label: strip(item.label), key: `${strip(item.group)}/${strip(item.label)}`, pattern: compilePattern(strip(item.pattern)) })),
      title_exclusions: (data.excluded_titles ?? []).map(compilePattern),
    }),
    catch: invalid,
  });
});

const tracked = packageConfigPath(import.meta.url, "market_taxonomy.toml");
const invalidLink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));

export const loadTaxonomy = (root?: string): Effect.Effect<Taxonomy, MarketError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  let path = tracked;

  if (root !== undefined) {
    const local = yield* checkedInstallationSetting(root, "local_only/config/market_taxonomy.toml");
    const exists = yield* fs.stat(local).pipe(Effect.as(true), Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(error)));

    if (exists) path = local;
    else {
      const link = yield* fs.readLink(local).pipe(Effect.as(true), Effect.catchTag("SystemError", (error) => error.reason === "NotFound" || invalidLink(error.cause) ? Effect.succeed(false) : Effect.fail(error)));

      if (link) path = local;
    }
  }

  const text = yield* fs.readFileString(path);

  return yield* parseTaxonomy(text);
}).pipe(Effect.mapError((error) => error instanceof MarketError ? error : new MarketError({ message: "Cannot read market taxonomy" })));
