import { Option, Schema } from "effect";
import { parseIsoDate } from "./iso-time.ts";
import { RejudgeOptions } from "./reviewer-settings.ts";
import { PROFILE_TEXT_MAX_BYTES } from "./profile.ts";
import { boundedInteger, boundedText, finiteNumber, integerToken } from "./support.ts";

const encoder = new TextEncoder();

export const DisplaySettingsList = Schema.Array(boundedText()).pipe(
  Schema.maxItems(2000),
  Schema.filter((values) => encoder.encode(JSON.stringify(values)).byteLength <= 32_768),
);

const textList = Schema.NullOr(DisplaySettingsList);
const number = Schema.Union(integerToken, finiteNumber);
export const DisplayModelLabel = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*(?![\s\S])/), Schema.maxLength(100));

const reviewer = (maxBatch: number) => Schema.Struct({
  harness: Schema.Literal("pi", "claude-code"),
  provider: Schema.NullOr(DisplayModelLabel),
  model: Schema.NullOr(DisplayModelLabel),
  effort: Schema.Literal("minimal", "low", "medium", "high", "xhigh", "max"),
  batch_size: boundedInteger(1, maxBatch),
});

const savedDate = Schema.String.pipe(Schema.filter((value) => Option.exists(parseIsoDate(value), (date) => date.text === value)));
const timezone = Schema.Literal("Europe/Oslo");

const recurrence = Schema.Struct({
  kind: Schema.Literal("daily", "weekly", "every_n_weeks", "monthly", "every_n_days"),
  timezone,
  interval: boundedInteger(1, 90),
  weekday: Schema.NullOr(boundedInteger(0, 6)),
  day_of_month: Schema.NullOr(boundedInteger(1, 28)),
  time: Schema.String.pipe(Schema.pattern(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)),
  anchor: Schema.NullOr(savedDate),
}).pipe(Schema.filter((period) => {
  const interval = period.kind === "every_n_days" || period.kind === "every_n_weeks";
  const weekday = period.kind === "weekly" || period.kind === "every_n_weeks";

  return (interval || (period.interval === 1 && period.anchor === null))
    && (period.kind !== "every_n_weeks" || (period.interval <= 52
      && (period.anchor === null || (new Date(period.anchor).getUTCDay() + 6) % 7 === period.weekday)))
    && weekday === (period.weekday !== null)
    && (period.kind === "monthly") === (period.day_of_month !== null);
}));

export const SnapshotSettings = Schema.Struct({
  policy: Schema.Struct({ market_only: Schema.Boolean, freshness_max_age_hours: number.pipe(Schema.greaterThan(0)) }),
  filters: Schema.Struct({
    radius_km: number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000)),
    preferred_municipalities: textList,
    nearby_municipalities: textList,
    excluded_municipalities: textList,
    allowed_occupation_categories: textList,
    excluded_title_terms: textList,
    excluded_employers: textList,
    preferred_terms: textList,
  }),
  title_screen: Schema.Struct({ academic: textList, business_development: textList, sales: textList, tech_words: textList }),
  sources: Schema.Struct({ name: Schema.Literal("nav"), excludes_finn: Schema.Literal(true) }),
  review: Schema.Struct({ screen: reviewer(120), judge: reviewer(10), rejudge: reviewer(120), calibrate: reviewer(120) }),
  schedule: Schema.Union(Schema.Struct({ kind: Schema.Literal("never"), timezone }), recurrence),
  notifications_enabled: Schema.optionalWith(Schema.Boolean, { exact: true }),
});

export type SnapshotSettings = typeof SnapshotSettings.Type;

export const SnapshotSettingsV4 = Schema.extend(SnapshotSettings, Schema.Struct({ rejudge: Schema.optionalWith(RejudgeOptions, { exact: true }) }));

export type SnapshotSettingsV4 = typeof SnapshotSettingsV4.Type;

export const SnapshotLocationLabel = boundedText();

export const SnapshotPersonalInputs = Schema.Struct({
  home_location: Schema.Struct({
    label: Schema.NullOr(SnapshotLocationLabel),
    home_postcode: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^\p{Nd}{4}$/u))),
    area_postcode: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/))),
    origin: Schema.NullOr(Schema.Struct({
      latitude: number.pipe(Schema.between(-90, 90)),
      longitude: number.pipe(Schema.between(-180, 180)),
      source: Schema.NullOr(SnapshotLocationLabel),
    })),
  }),
  narrative: Schema.String.pipe(Schema.filter((text) =>
    text.length > 0 && text.isWellFormed() && encoder.encode(text).byteLength <= PROFILE_TEXT_MAX_BYTES)),
});

export type SnapshotPersonalInputs = typeof SnapshotPersonalInputs.Type;
