import type { Preferences } from "../../contracts/profile-settings.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { normalized, strip } from "../shared/text.ts";
import { matchesTerm, NEUTRAL_TITLE_EVIDENCE, withoutReflexive, type TitleEvidence } from "./title-evidence.ts";

export interface PreliminaryAssessment {
  readonly signals: readonly string[];
  readonly excluded_reason: string | null;
  readonly classification: "strong" | "adjacent" | "uncertain";
  readonly title_signals: readonly string[];
  readonly reasons: readonly string[];
  readonly unknowns: readonly string[];
  readonly relevance_score: number;
}

export type TitleExclusion = (cleanTitle: string) => string | null;

// The caller selects an operation-specific Screen context. This pure function
// does not read settings, infer owner defaults or compile arbitrary patterns.
export const assess = (
  title: string, employer: string, municipalities: readonly string[], _postcodes: readonly string[],
  topics: readonly string[], preferences: Preferences, excludeTitle: TitleExclusion, evidencePack: TitleEvidence = NEUTRAL_TITLE_EVIDENCE,
): PreliminaryAssessment => {
  const places = new Set<string>();

  for (const value of municipalities) if (strip(value)) places.add(normalized(value));
  const reasons: string[] = [];
  const cleanTitle = withoutReflexive(title);
  const titleReason = excludeTitle(cleanTitle);

  if (titleReason !== null) reasons.push(titleReason);

  if (preferences.excluded_title_terms.some((term) => matchesTerm(term, title))) reasons.push("explicit title exclusion");

  if (new Set(preferences.excluded_employers.map(normalized)).has(normalized(employer))) reasons.push("explicit employer exclusion");
  const excluded = new Set(preferences.excluded_municipalities.map(normalized));

  if (places.size && [...places].every((place) => excluded.has(place))) reasons.push("all known municipalities explicitly excluded");
  const signals = new Set(topics.filter((topic) => evidencePack.sourceTags.has(topic)));

  for (const term of preferences.preferred_terms) {
    if (!matchesTerm(term, title)) continue;
    signals.add(evidencePack.topics(term)[0] ?? "term: " + term);
  }

  const titleSignals = new Set<string>(evidencePack.topics(cleanTitle));
  const roles = evidencePack.roles(cleanTitle);

  for (const role of roles) titleSignals.add(role);

  for (const signal of signals) if (signal.startsWith("term: ")) titleSignals.add(signal);

  for (const signal of titleSignals) signals.add(signal);
  const sortedTitles = [...titleSignals].sort(codepointOrder);

  const evidence = roles.length ? "Relevant role wording in title: " + [...roles].sort(codepointOrder).join(", ") + "."
    : titleSignals.size ? "Interest wording in title, but role relevance is not established: " + sortedTitles.join(", ") + "."
      : signals.size ? "Stored topic mentions have no retained context; they may be incidental."
        : "No retained title or topic evidence for the discovery interests.";

  return {
    signals: [...signals].sort(codepointOrder),
    excluded_reason: reasons.length ? reasons.join("; ") : null,
    classification: roles.length ? "strong" : titleSignals.size ? "adjacent" : "uncertain", title_signals: sortedTitles,
    reasons: [evidence], unknowns: ["Suitability, salary, seniority, language, and remote-work terms are not established."],
    relevance_score: roles.length ? 2 : titleSignals.size ? 1 : 0,
  };
};

export const assessmentSortKey = (assessment: PreliminaryAssessment): readonly [number, number] =>
  [-assessment.relevance_score, -assessment.signals.length];
