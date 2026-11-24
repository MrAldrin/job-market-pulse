import { FileSystem } from "@effect/platform";
import { Context, Effect, Either, Layer, Option } from "effect";
import { SettingsSuggestionRequest, settingsSuggestionsPath, type SettingsHelper, type SettingsSuggestionResult } from "../../contracts/settings-suggestions.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { generateSettingsSuggestion } from "../calibrate/settings-suggestions.ts";
import { readPhoneFeedbackEvents } from "../feedback/phone-events.ts";
import { ReviewerHarness } from "../judge/harness.ts";
import { LocalProfileSettings } from "../profile/local-settings.ts";
import { csrfWriteAuthorized, type DashboardScheme } from "./auth.ts";
import { DashboardConfig } from "./config.ts";
import { jsonResponse, readViewerJson, textResponse } from "./response.ts";
import { DashboardSnapshot } from "./snapshot.ts";

export class DashboardSettingsSuggestions extends Context.Tag("pulse/DashboardSettingsSuggestions")<DashboardSettingsSuggestions, {
  readonly generate: (helper: SettingsHelper) => Effect.Effect<SettingsSuggestionResult, Response>;
}>() {}

const unavailable = () => textResponse("Suggestion inputs are unavailable.", 503);

export const DashboardSettingsSuggestionsLive = Layer.effect(DashboardSettingsSuggestions, Effect.gen(function* () {
  const config = yield* DashboardConfig;
  const snapshot = yield* DashboardSnapshot;
  const settings = yield* LocalProfileSettings;
  const harness = yield* ReviewerHarness;
  const fs = yield* FileSystem.FileSystem;
  const permit = yield* Effect.makeSemaphore(1);

  const generate = (helper: SettingsHelper) => Effect.gen(function* () {
    const target = config.mode === "local" ? config.localSettings : undefined;

    if (!target) return yield* Effect.fail(unavailable());
    const saved = yield* settings.read(target).pipe(Effect.mapError(unavailable));
    const document = yield* snapshot.readDocument.pipe(Effect.mapError(unavailable));

    if (document && document.profile.id !== target.profileId) return yield* Effect.fail(unavailable());
    const jobs = document?.jobs ?? [];
    const needsReactions = helper !== "title_exclusion";

    const events = needsReactions && jobs.length && config.feedbackProfile === target.profileId
      ? yield* readPhoneFeedbackEvents(config.feedbackDb, target.profileId).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(unavailable)) : null;

    const reactions = events && new Map(events.flatMap((event) => event.kind === "reaction" ? [[event.listing_id, event.value] as const] : []));

    return yield* generateSettingsSuggestion(harness, helper, { saved, jobs, reactions }).pipe(Effect.mapError(({ code }) => {
      switch (code) {
        case "inputs": return unavailable();
        case "missing": return textResponse("Could not find the configured calibration harness on PATH.", 503);
        case "timeout": return textResponse("The suggestion request timed out.", 504);
        case "invalid": return textResponse("The harness did not return a valid suggestion.", 502);
      }
    }));
  });

  return { generate: (helper) => permit.withPermitsIfAvailable(1)(generate(helper)).pipe(Effect.flatMap((result) =>
    Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(textResponse("Another suggestion request is in progress.", 409)))) };
}));

const decodeRequest = decodeStrict(SettingsSuggestionRequest);

export const settingsSuggestionResponse = (request: Request, url: URL, csrf: string, scheme: DashboardScheme, service: DashboardSettingsSuggestions["Type"]) => Effect.gen(function* () {
  if (url.href !== url.origin + settingsSuggestionsPath) return textResponse("Not found", 404, request.method === "HEAD");

  if (request.method !== "POST") return textResponse("Method not allowed", 405, request.method === "HEAD");

  if (!csrfWriteAuthorized(request, csrf, scheme)) return textResponse("Forbidden", 403);
  const raw = yield* readViewerJson(request, 1024);
  const { helper } = yield* Either.mapLeft(decodeRequest(raw), () => textResponse("Invalid suggestion request", 400));
  const result = yield* service.generate(helper);

  return jsonResponse(JSON.stringify(result));
}).pipe(Effect.catchAll(Effect.succeed));
