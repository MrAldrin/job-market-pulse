import type { OwnedSettings } from "../../src/lib/server/profile/service.ts";
import { defaultPreferences } from "../../src/lib/server/profile/settings.ts";
import { NEUTRAL_RULES_FINGERPRINT } from "../../src/lib/server/filter/screen-context.ts";
import type { SourceAd } from "../../src/lib/server/filter/source-policy.ts";

export const version = "2026-10-19T10:00:00+00:00";
export const uuid = "00000000-0000-4000-8000-000000000001";

export const filterSettings = (): OwnedSettings => ({
  filters: { geography: { radius_km: 60, origin_latitude: 0, origin_longitude: 0, origin_source: "synthetic" }, jobs: { allowed_occupation_categories: ["IT"] } },
  judge: { jobs: { preferred_terms: [] } }, screen: { version: "neutral-v1", academic: [], business_development: [], sales: [], tech_words: [] },
  preferences: { ...defaultPreferences, radius_km: 60, origin_latitude: 0, origin_longitude: 0, origin_source: "synthetic", allowed_occupation_categories: ["IT"] },
  preference_fingerprint: "b".repeat(64), profile_fingerprint: "a".repeat(64), rules_fingerprint: NEUTRAL_RULES_FINGERPRINT,
});

export const sourceAd = (id = uuid, title = "General role", extra: Partial<SourceAd> = {}): SourceAd => ({
  uuid: id, title, changed: version, first_seen: version, observed: version, employer: "Example",
  locations: '["Near"]', topics: "[]", detail_missing: 0, expires: null, source: "SYNTHETIC", ...extra,
});
