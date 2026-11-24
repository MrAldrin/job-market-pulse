import { Either, Option, Schema } from "effect";
import { parseIsoDate } from "../../contracts/iso-time.ts";
import { DisplayModelLabel, DisplaySettingsList, SnapshotLocationLabel, type SnapshotPersonalInputs, type SnapshotSettings, SnapshotSettingsV4 } from "../../contracts/snapshot-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { rejudgeReviewer, type ModelSettings, type Reviewer } from "../judge/reviewers.ts";
import type { PeriodError } from "../profile/errors.ts";
import { parsePeriod, validatePeriod } from "../profile/schedule-period.ts";
import type { LoadedProfile } from "../profile/service.ts";

const isList = Schema.is(DisplaySettingsList);
const isLabel = Schema.is(DisplayModelLabel);
const isLocationLabel = Schema.is(SnapshotLocationLabel);
const displayList = (values: readonly string[]) => isList(values) ? values : null;

const reviewerLabels = ({ harness, provider, model, effort, batch_size }: Reviewer) => ({
  harness, provider: isLabel(provider) ? provider : null, model: isLabel(model) ? model : null, effort, batch_size,
});

const decodeSettings = decodeStrict(Schema.typeSchema(SnapshotSettingsV4));

export const projectSnapshotPersonalInputs = ({ settings, narrative }: LoadedProfile): SnapshotPersonalInputs => {
  const prefs = settings.preferences;

  return {
    home_location: {
      label: isLocationLabel(prefs.home_label) ? prefs.home_label : null,
      home_postcode: prefs.home_postcode || null,
      area_postcode: null,
      origin: prefs.origin_latitude === null || prefs.origin_longitude === null || !prefs.origin_source
        ? null
        : {
          latitude: prefs.origin_latitude, longitude: prefs.origin_longitude,
          source: isLocationLabel(prefs.origin_source) ? prefs.origin_source : null,
        },
    },
    narrative,
  };
};

const capturedSchedule = ({ expression, anchor }: LoadedProfile["schedule"], timezone: "Europe/Oslo"): Either.Either<SnapshotSettings["schedule"], PeriodError> => {
  if (expression === "never") return Either.right({ kind: "never", timezone } as const);

  // Parse the recurrence without using the parser's generated anchor as saved state.
  return Either.map(parsePeriod(expression, "2000-01-01"), (period) => {
    const saved = period.anchor === null || anchor === null ? null : Option.getOrNull(Option.map(parseIsoDate(anchor), (date) => date.text));

    return {
      kind: period.kind, timezone, interval: period.n, weekday: period.weekday, day_of_month: period.day_of_month, time: period.time,
      anchor: saved !== null && Either.isRight(validatePeriod({ ...period, anchor: saved })) ? saved : null,
    };
  });
};

export const projectSnapshotSettings = ({ bundle, settings, schedule }: LoadedProfile, models: ModelSettings, notificationsEnabled = false) => {
  const { policy } = bundle;
  const { preferences, screen } = settings;

  return Either.flatMap(capturedSchedule(schedule, policy.timezone), (captured) => {
    const projected = {
    policy: { market_only: policy.market_only, freshness_max_age_hours: policy.freshness_max_age.$seconds / 3600 },
    filters: {
      radius_km: preferences.radius_km,
      preferred_municipalities: displayList(preferences.preferred_municipalities),
      nearby_municipalities: displayList(preferences.nearby_municipalities),
      excluded_municipalities: displayList(preferences.excluded_municipalities),
      allowed_occupation_categories: displayList(preferences.allowed_occupation_categories),
      excluded_title_terms: displayList(preferences.excluded_title_terms),
      excluded_employers: displayList(preferences.excluded_employers),
      preferred_terms: displayList(preferences.preferred_terms),
    },
    title_screen: {
      academic: displayList(screen.academic ?? []), business_development: displayList(screen.business_development ?? []),
      sales: displayList(screen.sales ?? []), tech_words: displayList(screen.tech_words ?? []),
    },
    sources: { name: "nav", excludes_finn: true },
    review: {
      screen: reviewerLabels(models.screen), judge: reviewerLabels(models.judge),
      rejudge: reviewerLabels(models.rejudgeOptions === undefined ? models.rejudge : rejudgeReviewer(models)), calibrate: reviewerLabels(models.calibrate),
    },
    schedule: captured,
    notifications_enabled: notificationsEnabled,
    };

    return decodeSettings(models.rejudgeOptions === undefined ? projected : { ...projected, rejudge: models.rejudgeOptions });
  });
};
