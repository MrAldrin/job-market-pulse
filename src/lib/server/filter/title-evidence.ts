import { containsLiteral, literalSource as literal } from "../shared/literal-match.ts";
import { pythonSpaceClass as space, pythonWordClass as word, strip } from "../shared/text.ts";

const alternatives = (...values: readonly string[]): string => "(?:" + values.join("|") + ")";
const reflexive = new RegExp("(?<!" + word + ")" + alternatives(...["utvikler", "utvikle"].flatMap((verb) => ["deg", "seg"].map((pronoun) => literal(verb) + space + "+" + literal(pronoun)))) + "(?!" + word + ")", "gu");

export const withoutReflexive = (text: string): string => text.replace(reflexive, " ");

export const matchesTerm = (phrase: string, text: string): boolean => {
  const trimmed = strip(phrase);

  if (!trimmed) return false;
  const reflexivePhrase = withoutReflexive(trimmed) !== trimmed;

  return containsLiteral(reflexivePhrase ? text : withoutReflexive(text), trimmed);
};

export interface TitleEvidence {
  readonly scoringVersion: string;
  readonly sourceTags: ReadonlySet<string>;
  readonly topics: (text: string) => readonly string[];
  readonly roles: (text: string) => readonly string[];
}

export const NEUTRAL_TITLE_EVIDENCE: TitleEvidence = {
  scoringVersion: "title-evidence-pack-v1-neutral", sourceTags: new Set(), topics: () => [], roles: () => [],
};
