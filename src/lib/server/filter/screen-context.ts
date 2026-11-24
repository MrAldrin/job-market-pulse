import { Either } from "effect";
import neutralBytes from "../../../../resources/profile/neutral-screen-source.json";
import type { OwnedSettings } from "../profile/service.ts";
import { sha256 } from "../shared/python-json.ts";
import type { TitleExclusion } from "./assessment.ts";
import { FilterInputError, type FilterError } from "./errors.ts";
import { compileScreenRules } from "./screen-rules.ts";

export interface ScreenContext {
  readonly rules_fingerprint: string;
  readonly excludeTitle: TitleExclusion;
}

// Exact tracked public neutral TOML bytes, packaged as immutable data. This is
// not a second mutable settings loader and never reads legacy/owner paths.
export const NEUTRAL_RULES_FINGERPRINT = sha256(neutralBytes);

export const NEUTRAL_SCREEN: ScreenContext = Object.freeze({
  rules_fingerprint: NEUTRAL_RULES_FINGERPRINT,
  excludeTitle: (_title: string) => null,
});

export const personalScreen = (override?: ScreenContext): ScreenContext => override ?? NEUTRAL_SCREEN;

// Manual/scored Source work compiles the Profile-selected native regexes.
// An explicitly supplied trusted context must retain that same parsed rule hash;
// invalid config never silently becomes neutral.
export const manualScreen = (settings: OwnedSettings, selected?: ScreenContext): Either.Either<ScreenContext, FilterError> =>
  Either.flatMap(compileScreenRules(settings.screen, settings.rules_fingerprint), (compiled) =>
    selected === undefined ? Either.right(compiled)
      : selected.rules_fingerprint === settings.rules_fingerprint ? Either.right(selected)
        : Either.left(new FilterInputError({ message: "Selected Screen does not match the Profile rules fingerprint" })),
  );
