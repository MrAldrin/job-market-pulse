import { Schema } from "effect";
import { LocalFiltersUpdate, LocalJudgeUpdate, LocalNarrativeUpdate, LocalTitleTermsUpdate } from "./local-settings.ts";

export const settingsSuggestionsPath = "/app/local-settings/suggestions";
export const SettingsHelper = Schema.Literal("profile_from_feedback", "title_exclusion", "employer_exclusion", "preferred_term", "remove_exclusion");

export type SettingsHelper = typeof SettingsHelper.Type;

export const SettingsSuggestionRequest = Schema.Struct({ helper: SettingsHelper });

export const maxSuggestionEvidence = 24;

export const suggestionLine = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter((value) =>
  value.isWellFormed() && value === value.trim() && value.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(value)));

const Evidence = Schema.Struct({
  job_id: Schema.String, title: suggestionLine(300), signal: Schema.Literal("liked", "disliked", "poor"),
});

const ProposalDetails = {
  reason: suggestionLine(600), evidence: Schema.Array(Evidence).pipe(Schema.minItems(1), Schema.maxItems(maxSuggestionEvidence)),
};

const ProfileProposal = Schema.Struct({ ...ProposalDetails, change: LocalNarrativeUpdate });

const TitleProposal = Schema.Struct({ ...ProposalDetails, change: LocalTitleTermsUpdate, term: suggestionLine(120) });

const Count = Schema.Int.pipe(Schema.between(0, 2000));

export const SettingsSuggestionResult = Schema.Union(
  Schema.Struct({ helper: Schema.Literal("profile_from_feedback"), input: Schema.Struct({ liked: Count, disliked: Count }), proposal: Schema.NullOr(ProfileProposal) }),
  Schema.Struct({ helper: Schema.Literal("title_exclusion"), input: Schema.Struct({ poor: Count, checked: Count }), proposal: Schema.NullOr(TitleProposal) }),
  Schema.Struct({ helper: Schema.Literal("employer_exclusion"), input: Schema.Struct({ employers: Count, checked: Count }), proposal: Schema.NullOr(Schema.Struct({ ...ProposalDetails, employer: suggestionLine(300), change: LocalFiltersUpdate })) }),
  Schema.Struct({ helper: Schema.Literal("preferred_term"), input: Schema.Struct({ liked: Count }), proposal: Schema.NullOr(Schema.Struct({ ...ProposalDetails, term: suggestionLine(120), change: LocalJudgeUpdate })) }),
  Schema.Struct({ helper: Schema.Literal("remove_exclusion"), input: Schema.Struct({ candidates: Count }), proposal: Schema.NullOr(Schema.Struct({ ...ProposalDetails,
    rule: suggestionLine(300), change: Schema.Union(LocalTitleTermsUpdate, LocalFiltersUpdate),
  })) }),
);

export type SettingsSuggestionResult = typeof SettingsSuggestionResult.Type;
