import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import neutralSource from "../../resources/profile/neutral-screen-source.json";
import type { OwnedSettings } from "../../src/lib/server/profile/service.ts";
import { defaultPreferences } from "../../src/lib/server/profile/settings.ts";
import { assess } from "../../src/lib/server/filter/assessment.ts";
import { manifestCommon } from "../../src/lib/server/filter/manifest.ts";
import { manualScreen, NEUTRAL_RULES_FINGERPRINT, personalScreen, type ScreenContext } from "../../src/lib/server/filter/screen-context.ts";
import { matchesTerm } from "../../src/lib/server/filter/title-evidence.ts";

const settings: OwnedSettings = {
  filters: { geography: { radius_km: 40, origin_latitude: 60, origin_longitude: 10, origin_source: "synthetic", }, jobs: { allowed_occupation_categories: ["IT"] } },
  judge: { jobs: { preferred_terms: ["Python"] } }, screen: { academic: ["invented marker"] },
  preferences: { ...defaultPreferences, radius_km: 40, origin_latitude: 60, origin_longitude: 10, origin_source: "synthetic", preferred_terms: ["Python"], allowed_occupation_categories: ["IT"] },
  preference_fingerprint: "b".repeat(64), profile_fingerprint: "a".repeat(64), rules_fingerprint: "c".repeat(64),
};

// Test resource: this is not a production Screen compiler or a grammar promise.
const invented: ScreenContext = { rules_fingerprint: settings.rules_fingerprint, excludeTitle: (title) => matchesTerm("invented marker", title) ? "title exclusion: academic post" : null };

describe("operation-specific Screen selection", () => {
  it("packages exact public neutral bytes and unchanged source-byte identity", () => {
    expect(neutralSource).toBe(readFileSync("config/title_exclusions.neutral.toml", "utf8"));
    expect(NEUTRAL_RULES_FINGERPRINT).toBe("2e8c809cb8945e4edd0760d0207b3d22789f628542f3f778b64068bf99e62905");
  });

  it("keeps default personal manifests neutral despite non-neutral Profile rules", () => {
    const common = Either.getOrThrow(manifestCommon("fixture", settings));
    const explicit = Either.getOrThrow(manifestCommon("fixture", settings, invented));

    expect(common.rules_fingerprint).toBe(NEUTRAL_RULES_FINGERPRINT);
    expect(explicit.rules_fingerprint).toBe(settings.rules_fingerprint);
    expect(common.preferences_fingerprint).toBe(settings.preference_fingerprint);
    expect(common.profile_fingerprint).toBe(settings.profile_fingerprint);
    expect(personalScreen().excludeTitle("invented marker developer")).toBeNull();
    expect(personalScreen(invented).excludeTitle("invented marker developer")).toBe("title exclusion: academic post");
  });

  it("requires the Profile context for manual scoring and never reads legacy path metadata", () => {
    const poisoned = { ...settings, get legacyPreferencesPath(): string { throw new Error("Legacy metadata was accessed"); } };
    const manual = Either.getOrThrow(manualScreen(poisoned, invented));
    const title = "invented marker developer";

    expect(assess(title, "Example", [], [], [], poisoned.preferences, manual.excludeTitle).excluded_reason).toBe("title exclusion: academic post");
    expect(assess(title, "Example", [], [], [], poisoned.preferences, personalScreen().excludeTitle).excluded_reason).toBeNull();
    expect(Either.isLeft(manualScreen(poisoned, personalScreen()))).toBe(true);
    expect(Either.isRight(manifestCommon("fixture", poisoned))).toBe(true);
  });
});
