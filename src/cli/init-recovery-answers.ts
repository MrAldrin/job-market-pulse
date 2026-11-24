import { Predicate, Schema } from "effect";
import { TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import { modelSteps } from "../lib/server/judge/reviewers.ts";
import type { OccupationBox } from "../lib/server/profile/occupation-catalog.ts";
import type { InterviewFacts } from "./interview-session.ts";

const setupFields = [
  "profile_id", "search_mode", "timezone", "place_query", "lookup_place", "origin_mode", "latitude_input", "longitude_input",
  "area_postcode", "home_label", "origin_latitude", "origin_longitude", "origin_source", "radius_input", "radius_km", "occupation_choices",
  "allowed_occupation_categories", "excluded_title_terms", "excluded_employers", "preferred_terms", "excluded_title_terms_input", "excluded_employers_input", "preferred_terms_input",
  "ai_common", "ai_common_replaced", "ai_setup", "ai_program", "ai_model", "ai_effort", "reviewer",
  "schedule_choice", "schedule_period", "schedule_normalized", "schedule_anchor", "schedule_confirm", "schedule_count", "schedule_day", "schedule_weekday", "schedule_time",
  "interview", "keep_narrative", "interview_existing", "interview_method",
];

const strings = Schema.is(Schema.Array(Schema.String));

const listFields = new Set(["allowed_occupation_categories", "excluded_title_terms", "excluded_employers", "preferred_terms"]);
const numberFields = new Set(["origin_latitude", "origin_longitude", "radius_km", ...modelSteps.map((step) => `${step}_batch_size`)]);
const statuses = new Set(["kept", "planned", "incomplete", "later", "skipped"]);
const methods = new Set(["1", "2", "3", "guided", "agent", "short", "form", "later"]);
const existing = new Set(["1", "2", "3", "keep", "yes", "adjust", "reinterview"]);

const safeValue = (key: string, value: TomlValue): boolean => {
  if (listFields.has(key)) return strings(value);

  if (numberFields.has(key)) return Predicate.isBigInt(value) || (Predicate.isNumber(value) && Number.isFinite(value));

  if (key === "schedule_anchor") return Predicate.isString(value) || Predicate.isBigInt(value) || (value instanceof TomlDate && value.isDate());

  if (!Predicate.isString(value)) return false;

  if (key === "interview") return statuses.has(value);

  if (key === "interview_method") return methods.has(value);

  if (key === "interview_existing") return existing.has(value);

  return true;
};

export const setupRecoveryFields = (catalog: readonly OccupationBox[]): ReadonlySet<string> => new Set([
  ...setupFields,
  ...catalog.flatMap(({ name }) => [`occupation_${name}_mode`, `occupation_${name}_parts`]),
  ...modelSteps.flatMap((stage) => ["harness", "model", "effort", "batch_size"].map((field) => `${stage}_${field}`)),
]);

export type ValidatedSectionInput = Partial<Record<"interview_section" | "interview_replacement", string>>;

export const projectSetupRecovery = (answers: TomlTable, fields: ReadonlySet<string>, facts: InterviewFacts, sectionInput: Readonly<ValidatedSectionInput>): TomlTable => {
  const snapshot: TomlTable = {};

  for (const [key, value] of Object.entries(answers)) {
    if (Object.hasOwn(facts, key)) {
      const fact = facts[key];

      if (fact != null) snapshot[key] = fact;
    } else if (fields.has(key) && safeValue(key, value)) snapshot[key] = value;
    else if (key === "interview_section" || key === "interview_replacement") {
      const accepted = sectionInput[key];

      if (accepted !== undefined && value === accepted) snapshot[key] = accepted;
    }
  }

  return snapshot;
};
