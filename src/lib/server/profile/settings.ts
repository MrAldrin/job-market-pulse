import { Either, Predicate } from "effect";
import { FiltersSettings, JudgeSettings, type Preferences, ScreenSettings } from "../../contracts/profile-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { collapseWhitespace, normalized, strip } from "../shared/text.ts";
import { parseToml } from "../shared/toml.ts";
import { PythonFloat, pythonJson, sha256 } from "../shared/python-json.ts";
import { ProfileError } from "./errors.ts";

export const defaultPreferences: Preferences = {
  home_postcode: "", radius_km: 25, origin_latitude: null, origin_longitude: null,
  origin_source: "", preferred_municipalities: [], nearby_municipalities: [],
  preferred_terms: [], excluded_title_terms: [], excluded_employers: [],
  allowed_occupation_categories: [], excluded_municipalities: [], home_label: "",
};

export const uniqueStrings = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const original of values) {
    const value = collapseWhitespace(original);
    const key = normalized(value);

    if (!seen.has(key)) {
      result.push(value);
      seen.add(key);
    }
  }

  return result;
};

const invalid = () => new ProfileError({ message: "Invalid profile settings" });

export const decodeFilters = (text: string) => Either.flatMap(parseToml(text), (raw) => {
  if (Predicate.isRecord(raw.geography)) {
    delete raw.geography.preferred_municipalities;
    delete raw.geography.nearby_municipalities;
    delete raw.geography.area_postcode;
  }

  return Either.mapLeft(decodeStrict(FiltersSettings)(raw), invalid);
});

export const decodeJudge = (text: string) => Either.flatMap(parseToml(text), (raw) =>
  Either.mapLeft(decodeStrict(JudgeSettings)(raw), invalid),
);

export const decodeScreen = (text: string) => Either.flatMap(parseToml(text), (raw) =>
  Either.mapLeft(decodeStrict(ScreenSettings)(raw), invalid),
);

// Regex syntax includes meaningful whitespace. Only TOML formatting and the
// order/duplication of patterns within an OR group are immaterial.
export const screenVersion = (settings: ScreenSettings): string => sha256(pythonJson({
  academic: [...new Set(settings.academic ?? [])].sort(),
  business_development: [...new Set(settings.business_development ?? [])].sort(),
  sales: [...new Set(settings.sales ?? [])].sort(),
  tech_words: [...new Set(settings.tech_words ?? [])].sort(),
}));

// Each file is decoded by its owning Schema. Shared consumers receive values, not file paths.
export const mergePreferences = (filters: FiltersSettings, judge: JudgeSettings): Either.Either<Preferences, ProfileError> => {
  const geography = filters.geography;
  const origin = [geography?.origin_latitude, geography?.origin_longitude, geography?.origin_source];

  if (origin.some((value) => value !== undefined) && origin.some((value) => value === undefined)) {
    return Either.left(new ProfileError({ message: "Origin requires latitude, longitude, and source together" }));
  }

  return Either.right({
    home_postcode: geography?.home_postcode === undefined ? defaultPreferences.home_postcode : strip(geography.home_postcode),
    radius_km: Number(geography?.radius_km ?? defaultPreferences.radius_km),
    origin_latitude: geography?.origin_latitude ?? null,
    origin_longitude: geography?.origin_longitude ?? null,
    origin_source: geography?.origin_source === undefined ? "" : strip(geography.origin_source),
    home_label: geography?.home_label === undefined ? "" : collapseWhitespace(geography.home_label),
    preferred_municipalities: [], nearby_municipalities: [],
    excluded_municipalities: uniqueStrings(geography?.excluded_municipalities ?? []),
    excluded_title_terms: uniqueStrings(filters.jobs?.excluded_title_terms ?? []),
    excluded_employers: uniqueStrings(filters.jobs?.excluded_employers ?? []),
    allowed_occupation_categories: uniqueStrings(filters.jobs?.allowed_occupation_categories ?? []),
    preferred_terms: uniqueStrings(judge.jobs?.preferred_terms ?? []),
  });
};

export const preferenceVersion = (preferences: Preferences, radiusIdentity: number | bigint = preferences.radius_km): string => {
  const { home_label: _displayOnly, ...matching } = preferences;

  return sha256(pythonJson({
    ...matching,
    radius_km: Predicate.isBigInt(radiusIdentity) ? radiusIdentity : new PythonFloat(radiusIdentity),
    origin_latitude: preferences.origin_latitude === null ? null : new PythonFloat(preferences.origin_latitude),
    origin_longitude: preferences.origin_longitude === null ? null : new PythonFloat(preferences.origin_longitude),
  }));
};
