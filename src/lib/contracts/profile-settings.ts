import { Schema } from "effect";
import { TomlDate } from "smol-toml";
import { finiteNumber, integerToken, nonemptyText, nonemptyTextList as textList } from "./support.ts";
import { strip } from "../text-whitespace.ts";
import { decimalDigit } from "../unicode-characters.ts";

// Raw TOML integers retain their type until the owning Schema validates them.
export const tomlInteger = integerToken;

export const tomlNumber = Schema.Union(tomlInteger, finiteNumber);
const postcode = Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/));
export const radiusKm = finiteNumber.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1000));

export const FiltersSettings = Schema.Struct({
  geography: Schema.optional(Schema.Struct({
    home_postcode: Schema.optional(Schema.String.pipe(Schema.filter((text) => strip(text) === "" || (Array.from(strip(text)).length === 4 && Array.from(strip(text)).every(decimalDigit))))),
    area_postcode: Schema.optional(postcode),
    home_label: Schema.optional(nonemptyText),
    // Preserve integer/float identity inherited from a legacy base during explicit conversion.
    radius_km: Schema.optional(Schema.Union(
      Schema.BigIntFromSelf.pipe(Schema.betweenBigInt(1n, 1000n)),
      radiusKm,
    )),
    origin_latitude: Schema.optional(tomlNumber.pipe(Schema.between(-90, 90))),
    origin_longitude: Schema.optional(tomlNumber.pipe(Schema.between(-180, 180))),
    origin_source: Schema.optional(nonemptyText),
    preferred_municipalities: Schema.optional(textList),
    nearby_municipalities: Schema.optional(textList),
    excluded_municipalities: Schema.optional(textList),
  })),
  jobs: Schema.optional(Schema.Struct({
    excluded_title_terms: Schema.optional(textList),
    excluded_employers: Schema.optional(textList),
    allowed_occupation_categories: Schema.optional(textList),
  })),
});

export const JudgeSettings = Schema.Struct({ jobs: Schema.optional(Schema.Struct({ preferred_terms: Schema.optional(textList) })) });

export const ScreenSettings = Schema.Struct({
  version: Schema.optional(Schema.Unknown),
  academic: Schema.optional(textList),
  business_development: Schema.optional(textList),
  sales: Schema.optional(textList),
  tech_words: Schema.optional(textList),
});

const relativePath = nonemptyText.pipe(Schema.filter((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..") && value.split("/").some((part) => part !== "" && part !== ".")));
const isoDate = Schema.String.pipe(Schema.pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/));
const localDateToken = Schema.instanceOf(TomlDate).pipe(Schema.filter((date) => date.isDate() && date.isValid()));
export const tomlDate = Schema.Union(isoDate, localDateToken);

// Schedule validation accepts Python basic/week dates too, including integer
// basic-date tokens. Floating tokens and containers cannot stringify as dates.
const savedScheduleAnchor = Schema.Union(Schema.String, Schema.BigIntFromSelf, localDateToken);

// The frozen policy file intentionally allows inert extra data. This extension is
// file-local: known fields still validate, and no opaque field enters the bundle.
const configuration = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.extend(
  Schema.Struct(fields), Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

export const ProfileSettings = configuration({
  profile: configuration({ id: Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.maxLength(64)), timezone: Schema.optional(Schema.Unknown) }),
  paths: configuration({
    profile: relativePath, preferences: relativePath, source_db: relativePath,
    review_db: relativePath, ledger_db: relativePath, outbox: relativePath,
  }),
  policy: configuration({
    mode: Schema.Literal("passive", "active"),
    market_only: Schema.Boolean,
    freshness_max_age_hours: tomlNumber.pipe(Schema.greaterThan(0), Schema.lessThan(24 * 1_000_000_000), Schema.filter((hours) => Math.round(hours * 3_600_000_000) > 0)),
    cadence: Schema.optional(Schema.Literal("weekly", "fortnightly")),
    cadence_anchor: Schema.optional(tomlDate),
  }),
  review: Schema.optional(configuration({
    default_reviewer: Schema.optional(nonemptyText),
    full_review_batch_size: Schema.optional(tomlInteger.pipe(Schema.between(1, 10))),
  })),
  schedule: Schema.optional(Schema.Struct({ schedule: Schema.optional(Schema.String), anchor: Schema.optional(savedScheduleAnchor) })),
});

export type FiltersSettings = typeof FiltersSettings.Type;

export type JudgeSettings = typeof JudgeSettings.Type;

export type ScreenSettings = typeof ScreenSettings.Type;

export type ProfileSettings = typeof ProfileSettings.Type;

// Loaded preference shape remains the frozen dataclass shape. Setup metadata stays outside.
export const Preferences = Schema.Struct({
  home_postcode: Schema.String,
  radius_km: radiusKm,
  origin_latitude: Schema.NullOr(finiteNumber.pipe(Schema.between(-90, 90))),
  origin_longitude: Schema.NullOr(finiteNumber.pipe(Schema.between(-180, 180))),
  origin_source: Schema.String,
  preferred_municipalities: Schema.Array(Schema.String), nearby_municipalities: Schema.Array(Schema.String),
  preferred_terms: Schema.Array(Schema.String), excluded_title_terms: Schema.Array(Schema.String),
  excluded_employers: Schema.Array(Schema.String), allowed_occupation_categories: Schema.Array(Schema.String),
  excluded_municipalities: Schema.Array(Schema.String), home_label: Schema.String,
});

export type Preferences = typeof Preferences.Type;
