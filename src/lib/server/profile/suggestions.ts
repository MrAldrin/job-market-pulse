import { Either, Schema } from "effect";
import type { TomlTable } from "smol-toml";
import { decodeStrict } from "../../contracts/support.ts";
import { normalized, printable, strip } from "../shared/text.ts";
import { parseToml, writeToml } from "../shared/toml.ts";
import { ProfileError } from "./errors.ts";
import { decodeFilters } from "./settings.ts";

const shortLine = Schema.transform(
  Schema.String.pipe(Schema.filter((s) => strip(s).length > 0 && Array.from(s).length <= 500 && printable(s))),
  Schema.String, { strict: true, decode: strip, encode: (value) => value },
);

const Item = Schema.Struct({ value: shortLine, reason: shortLine });
const SuggestionData = Schema.Struct({ excluded_title_terms: Schema.optional(Schema.Array(Item).pipe(Schema.maxItems(100))), excluded_employers: Schema.optional(Schema.Array(Item).pipe(Schema.maxItems(100))), mode: Schema.optional(Schema.Struct({ value: Schema.transform(shortLine, Schema.Literal("passive", "active"), { strict: false, decode: (value) => strip(value), encode: (value) => value }), reason: shortLine })) });

export type Suggestions = typeof SuggestionData.Type;

const invalid = () => new ProfileError({ message: "Invalid suggestions" });
const keys = ["excluded_title_terms", "excluded_employers"] as const;

export const decodeSuggestions = (text: string): Either.Either<Suggestions, ProfileError> => Either.flatMap(parseToml(text), (raw) => Either.mapLeft(decodeStrict(SuggestionData)(raw), invalid));

export const applySuggestions = (filtersText: string, accepted: Suggestions): Either.Either<string, ProfileError> => Either.gen(function* () {
  const suggestions = yield* Either.mapLeft(decodeStrict(SuggestionData)(accepted), invalid);
  yield* decodeFilters(filtersText);
  const data = yield* parseToml(filtersText);
  // SAFETY: decodeFilters has validated jobs as a TOML table.
  const jobs = (data.jobs ?? {}) as TomlTable;
  let changed = false;

  for (const key of keys) {
    // SAFETY: decodeFilters has validated each present list as strings.
    const existing = (jobs[key] ?? []) as string[];
    const values = [...existing];
    const seen = new Set(existing.map(normalized));

    for (const item of suggestions[key] ?? []) {
      const value = strip(item.value);
      const identity = normalized(value);

      if (!seen.has(identity)) { values.push(value); seen.add(identity); changed = true; }
    }

    if (values.length !== existing.length) jobs[key] = values;
  }

  if (!changed) return filtersText;
  data.jobs = jobs;
  const output = yield* writeToml(data);
  yield* decodeFilters(output);

  return output;
});
