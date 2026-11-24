import { Either, Schema } from "effect";
import { ScreenSettings } from "../../contracts/profile-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import type { ScreenContext } from "./screen-context.ts";
import { FilterInputError, ScreenCompilationError, type FilterError } from "./errors.ts";
import { withoutReflexive } from "./title-evidence.ts";

const groups = ["academic", "business_development", "sales", "tech_words"] as const;

export const compileScreenRules = (settings: ScreenSettings, rulesFingerprint: string): Either.Either<ScreenContext, FilterError> => Either.gen(function* () {
  const parsed = yield* Either.mapLeft(decodeStrict(Schema.typeSchema(ScreenSettings))(settings), () => new FilterInputError({ message: "Invalid typed Screen settings" }));
  const compiled: Record<typeof groups[number], readonly RegExp[]> = { academic: [], business_development: [], sales: [], tech_words: [] };

  for (const group of groups) compiled[group] = yield* Either.all((parsed[group] ?? []).map((pattern) => Either.try({
    try: () => new RegExp(pattern, "iu"),
    catch: (error) => {
      if (error instanceof SyntaxError) return new ScreenCompilationError({ message: "Invalid Screen regex in " + group });
      throw error;
    },
  })));

  return {
    rules_fingerprint: rulesFingerprint,
    excludeTitle: (title: string): string | null => {
      const text = withoutReflexive(title);

      if (compiled.academic.some((pattern) => pattern.test(text))) return "title exclusion: academic post";

      if (compiled.business_development.some((pattern) => pattern.test(text))) return "title exclusion: business development role";

      if (compiled.sales.some((pattern) => pattern.test(text)) && !compiled.tech_words.some((pattern) => pattern.test(text))) return "title exclusion: sales role without tech title words";

      return null;
    },
  };
});
