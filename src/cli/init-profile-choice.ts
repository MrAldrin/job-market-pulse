import { Effect, Either, Schema } from "effect";
import { searchModes } from "../lib/search-mode.ts";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import type { InitQuestions } from "./init-prompts.ts";

const validModeChoice = Schema.is(Schema.Literal("1", "2", "passive", "active"));

// The state reader decides which profile is already selected. This step does
// not find or create another profile or change the CLI default.
export const chooseSetupProfile = <R = never, E = never>(ctx: InitQuestions, selected?: string, bind?: (id: string) => Effect.Effect<void, E, R>) => Effect.gen(function* () {
  const profileId = selected ?? (yield* ctx.answer("profile_id", {
    prompt: "Profile ID (example: scratch-tester)",
    validate: (value) => Either.isRight(decodeProfileId(value)) ? null : "Use lowercase letters, digits and single hyphens, at most 64 characters.",
  }));

  yield* decodeProfileId(profileId);
  ctx.answers.profile_id = profileId;

  if (bind) yield* bind(profileId);

  if (selected !== undefined) yield* ctx.say(`Profile: ${profileId}`);
  yield* ctx.say(`1. ${searchModes.passive.label} (passive)\n2. ${searchModes.active.label} (active)`);

  const choice = yield* ctx.answer("search_mode", {
    prompt: "Search mode",
    default: "passive",
    validate: (value) => validModeChoice(value) ? null : "Choose 1 or 2.",
  });

  const searchMode = choice === "2" || choice === "active" ? "active" : "passive";

  ctx.answers.search_mode = searchMode;

  return { profileId, searchMode } as const;
});
