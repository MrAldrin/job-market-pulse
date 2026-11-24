import { Effect, Predicate, Schema } from "effect";
import type { TomlTable, TomlValue } from "smol-toml";
import { modelSteps } from "../lib/server/judge/reviewers.ts";
import type { OccupationBox } from "../lib/server/profile/occupation-catalog.ts";
import { pythonFloat } from "../lib/server/shared/python-json.ts";
import { setupScheduleDefaults } from "./init-schedule.ts";
import { initError, isInitTomlTable, type InitState } from "./init-state.ts";

const strings = Schema.is(Schema.Array(Schema.String));

const inputNames = [
  ["origin_latitude", "latitude_input"], ["origin_longitude", "longitude_input"], ["radius_km", "radius_input"], ["home_label", "place_query"],
] as const;

const table = (value: TomlValue | undefined) => value === undefined ? Effect.succeed<TomlTable>({})
  : isInitTomlTable(value) ? Effect.succeed(value) : Effect.fail(initError("Existing split settings have an invalid table."));

const projectOccupations = (defaults: TomlTable, catalog: readonly OccupationBox[]): void => {
  const allowed = defaults.allowed_occupation_categories;

  if (!strings(allowed)) return;
  const chosen: string[] = [];

  for (const [index, box] of catalog.entries()) {
    const parts = box.level2.flatMap((child, part) => allowed.includes(`${box.name} / ${child}`) ? [String(part + 1)] : []);
    const all = allowed.includes(box.name);

    if (!all && !parts.length) continue;
    chosen.push(String(index + 1));
    defaults[`occupation_${box.name}_mode`] = all ? "all" : "some";

    if (parts.length) defaults[`occupation_${box.name}_parts`] = parts.join(",");
  }

  defaults.occupation_choices = chosen.join(",") || "none";
};

const projectModels = (defaults: TomlTable, models: TomlTable): void => {
  // Init state has already applied the owning Judge decoder to this snapshot.
  for (const stage of modelSteps) {
    const model = models[stage];

    if (!isInitTomlTable(model)) continue;

    for (const key of ["harness", "model", "effort", "batch_size"] as const) {
      const value = model[key];

      if (value !== undefined) defaults[`${stage}_${key}`] = value;
    }
  }
};

export const setupDefaults = (state: InitState, catalog: readonly OccupationBox[], osloDate: string) => Effect.gen(function* () {
  const defaults: TomlTable = {};
  const profile = state.profile;

  if (profile?.exists) {
    const policy = profile.config.policy;
    const geography = yield* table(profile.filters.geography);
    const filterJobs = yield* table(profile.filters.jobs);
    const judgeJobs = yield* table(profile.judge.jobs);
    defaults.profile_id = profile.id;

    if (isInitTomlTable(policy) && Predicate.isString(policy.mode)) defaults.search_mode = policy.mode;

    // Only setup-owned fields project into named answers. The plan preserves
    // other Filter settings in the committed file, not in the checkpoint.
    for (const key of ["origin_latitude", "origin_longitude", "origin_source", "radius_km", "home_label", "area_postcode"] as const) {
      const value = geography[key];

      if (value !== undefined) defaults[key] = value;
    }

    for (const key of ["allowed_occupation_categories", "excluded_title_terms", "excluded_employers"] as const) {
      const value = filterJobs[key];

      if (value !== undefined) defaults[key] = value;
    }

    const preferred = judgeJobs.preferred_terms;

    if (preferred !== undefined) defaults.preferred_terms = preferred;

    for (const [source, target] of inputNames) {
      const value = defaults[source];

      if (Predicate.isString(value) || Predicate.isBigInt(value)) defaults[target] = String(value);
      else if (Predicate.isNumber(value)) defaults[target] = pythonFloat(value);
    }

    if (Predicate.isString(defaults.area_postcode)) defaults.place_query = defaults.area_postcode;

    for (const key of ["preferred_terms", "excluded_title_terms", "excluded_employers"]) {
      const value = defaults[key];

      if (strings(value)) defaults[`${key}_input`] = value.join(", ");
    }

    projectOccupations(defaults, catalog);
    projectModels(defaults, state.models);
    Object.assign(defaults, yield* setupScheduleDefaults(profile.config, osloDate));
  } else {
    projectModels(defaults, state.models);

    if (profile) defaults.profile_id = profile.id;
  }

  return defaults;
});
