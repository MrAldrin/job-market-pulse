import type { Candidate } from "../../src/lib/contracts/filter.ts";
import { filterSettings, uuid, version } from "./fixtures.ts";

export const legacyEvidenceSettings = () => {
  const settings = filterSettings();

  return { ...settings, preferences: { ...settings.preferences, preferred_terms: ["SQL", "C++", "førstehjelp"] } };
};

export const legacyEvidenceCases = [
  ["AI / Researcher", []], ["ML specialist", []], ["SQL adviser", []],
  ["Senior data scientist", []], ["Dataplattformingeniør", []], ["Database utvikler", []],
  ["Backend-utvikler", []], ["Data\tEngineer", []], ["Data Engineer", []],
  ["Du utvikler deg", []], ["C++ rådgiver i førstehjelp", []],
  ["General adviser", ["programming", "AI / machine learning", "unknown"]],
] as const;

export const legacyEvidenceCandidate: Candidate = {
  id: uuid, version, title: "Data Engineer", employer: "Synthetic", locations: ["Near"],
  url: `https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`, expires_at: null,
  detail_missing: false, geography: "inside", geography_reason: "Synthetic verified point", occupation_categories: ["IT"],
};
