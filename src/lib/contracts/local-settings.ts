import { Schema } from "effect";
import { DashboardLink, NtfySettingsInput } from "./ntfy-settings.ts";
import { ProfileBundle, ProfileId, PROFILE_TEXT_MAX_BYTES } from "./profile.ts";
import { JudgeSettings, radiusKm, ScreenSettings, tomlNumber } from "./profile-settings.ts";
import { titleScreenTerm } from "../title-screen-terms.ts";
import { nonemptyTextList } from "./support.ts";
import { ModelLabel, ModelStep, ProviderLabel, RejudgeOptions, ReviewerEffort, ReviewerHarnessId } from "./reviewer-settings.ts";

export const localSettingsPath = "/app/local-settings";

const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}(?![\s\S])/));
const modelFields = { provider: ProviderLabel, model: ModelLabel };
const reviewer = Schema.Struct({ harness: ReviewerHarnessId, effort: ReviewerEffort, ...modelFields });

export type LocalReviewer = typeof reviewer.Type;

const PiCandidate = Schema.Struct({ ...modelFields, efforts: Schema.Array(ReviewerEffort).pipe(Schema.maxItems(6)) });
export const PiModelCatalog = Schema.Array(PiCandidate).pipe(Schema.maxItems(5000));

export type PiModelCatalog = typeof PiModelCatalog.Type;

export const claudePickerEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const modelAction = { revision: digest, step: ModelStep, ...reviewer.fields };

const locationValues = Schema.Struct({
  home_postcode: Schema.String.pipe(Schema.pattern(/^[0-9]{4}(?![\s\S])/)),
  radius_km: Schema.compose(tomlNumber, radiusKm),
});

const savedLocation = Schema.Struct({
  home_postcode: Schema.String,
  radius_km: radiusKm,
  place: Schema.NullOr(Schema.String),
});

const filterValues = Schema.Struct({
  excluded_municipalities: nonemptyTextList,
  excluded_employers: nonemptyTextList,
  allowed_occupation_categories: nonemptyTextList,
});

const preferredTerms = JudgeSettings.fields.jobs.from.fields.preferred_terms.from;
const { version: _version, ...screenFields } = ScreenSettings.fields;
export const screenListKeys = ["academic", "business_development", "sales", "tech_words"] as const;

const termList = Schema.Array(Schema.String.pipe(Schema.pattern(titleScreenTerm)));

const editableScreen = Schema.Struct({
  academic: Schema.optional(termList), business_development: Schema.optional(termList),
  sales: Schema.optional(termList), tech_words: Schema.optional(termList),
});

const advancedScreen = Schema.Struct(screenFields);
const searchMode = ProfileBundle.fields.policy.fields.mode;
const scheduleValues = Schema.Struct({ expression: Schema.String, anchor: Schema.NullOr(Schema.String) });

const encoder = new TextEncoder();

const narrativeText = Schema.String.pipe(Schema.filter((text) =>
  text.isWellFormed() && encoder.encode(text).byteLength <= PROFILE_TEXT_MAX_BYTES));

export const LocalSettingsDocument = Schema.Struct({
  profile_id: ProfileId,
  csrf_token: digest,
  models: Schema.Struct({ revision: digest, steps: Schema.Record({ key: ModelStep, value: reviewer }), pi_catalog: Schema.NullOr(PiModelCatalog) }),
  rejudge: Schema.optional(RejudgeOptions),
  filters: Schema.Struct({ revision: digest, excluded_title_terms: nonemptyTextList, location: savedLocation, ...filterValues.fields }),
  judge: Schema.NullOr(Schema.Struct({ revision: digest, preferred_terms: preferredTerms })),
  screen: Schema.NullOr(Schema.Struct({ revision: digest, values: editableScreen, advanced: advancedScreen })),
  search_mode: Schema.Struct({ revision: digest, mode: searchMode }),
  schedule: Schema.NullOr(Schema.Struct({ revision: digest, ...scheduleValues.fields })),
  narrative: Schema.NullOr(Schema.Struct({ revision: digest, text: narrativeText })),
  notifications: Schema.optional(Schema.NullOr(Schema.Struct({
    revision: digest, enabled: Schema.Boolean, topic_configured: Schema.Boolean, dashboard_url: Schema.NullOr(DashboardLink),
  }))),
});

export type LocalSettingsDocument = typeof LocalSettingsDocument.Type;

export const LocalFiltersUpdate = Schema.Struct({ kind: Schema.Literal("filters"), revision: digest, values: filterValues });
export const LocalJudgeUpdate = Schema.Struct({ kind: Schema.Literal("judge"), revision: digest, values: preferredTerms });

export const LocalTitleTermsUpdate = Schema.Struct({ kind: Schema.Literal("excluded_title_terms"), revision: digest, values: nonemptyTextList });
export const LocalNarrativeUpdate = Schema.Struct({ kind: Schema.Literal("narrative"), revision: digest, values: narrativeText });

export const LocalSettingsUpdate = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("model"), ...modelAction }),
  Schema.Struct({ kind: Schema.Literal("rejudge"), revision: digest, values: RejudgeOptions, model: Schema.NullOr(reviewer) }).pipe(
    Schema.filter(({ values, model }) => values.same_as_judge === (model === null))),
  LocalTitleTermsUpdate,
  LocalFiltersUpdate,
  Schema.Struct({ kind: Schema.Literal("location"), revision: digest, values: locationValues }),
  LocalJudgeUpdate,
  Schema.Struct({ kind: Schema.Literal("screen"), revision: digest, values: editableScreen }),
  Schema.Struct({ kind: Schema.Literal("search_mode"), revision: digest, values: searchMode }),
  Schema.Struct({ kind: Schema.Literal("schedule"), revision: digest, values: scheduleValues }),
  LocalNarrativeUpdate,
  Schema.Struct({ kind: Schema.Literal("notifications"), revision: digest, values: NtfySettingsInput }),
);

export type LocalSettingsUpdate = typeof LocalSettingsUpdate.Type;

export const LocalSettingsPost = Schema.Union(
  LocalSettingsUpdate,
  Schema.Struct({ kind: Schema.Literal("refresh_models") }),
  Schema.Struct({ kind: Schema.Literal("test_model"), ...modelAction }),
  Schema.Struct({ kind: Schema.Literal("test_notification"), revision: digest }),
);

export type LocalSettingsPost = typeof LocalSettingsPost.Type;

export const LocalSettingsSaved = Schema.Struct({ revision: digest, location: Schema.optional(savedLocation) });
