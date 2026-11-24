import { Effect, Either } from "effect";
import { isDashboardLink, isNtfyTopic } from "../lib/contracts/ntfy-settings.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { checkNtfyEdit, readNtfySettings, saveNtfySettings } from "../lib/server/profile/ntfy-settings.ts";
import { askInitText } from "./init-prompts.ts";
import type { InterviewIO } from "./interview-session.ts";

const yesNo = (io: InterviewIO, prompt: string, initial: boolean) => askInitText(io, {
  prompt, default: initial ? "yes" : "no", validate: (value) => /^(yes|no)$/i.test(value) ? null : "Answer yes or no.",
}).pipe(Effect.map((value) => value.toLowerCase() === "yes"));

export const planAlertSetup = (request: {
  readonly root: string;
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly answersPath?: string;
  readonly resume: boolean;
}, io: InterviewIO, askSecret: InterviewIO["ask"]) => Effect.gen(function* () {
  if (request.nonInteractive || request.answersPath !== undefined || request.resume) {
    return yield* io.say("Use a terminal for pulse init --step alert. Notification answers are not saved for resume.").pipe(Effect.as(1 as const));
  }

  const root = yield* (yield* ProfileFiles).root(request.root);
  const saved = yield* readNtfySettings(root);
  const enabled = yield* yesNo(io, "Enable automatic ntfy.sh notifications", saved.enabled);

  const topic = enabled ? (yield* askInitText({ ...io, ask: askSecret }, {
    prompt: saved.topic === null ? "Enter a secret random topic (24 to 64 letters, digits, hyphens or underscores)" : "Enter a new secret topic or press Enter to keep the saved topic",
    validate: (value) => (value === "" && saved.topic !== null) || isNtfyTopic(value) ? null : "Enter a valid secret topic.",
  })) || null : null;

  const dashboard_url = enabled ? (yield* askInitText(io, {
    prompt: saved.dashboard_url === null ? "HTTPS dashboard URL for the phone" : "Enter a new HTTPS dashboard URL or press Enter to keep the saved URL",
    validate: (value) => (value === "" && saved.dashboard_url !== null) || isDashboardLink(value) ? null : "Enter an HTTPS URL without credentials, a query or a fragment.",
  })) || saved.dashboard_url : saved.dashboard_url;

  const update = { enabled, dashboard_url, topic };

  if (Either.isLeft(checkNtfyEdit(saved, update))) {
    return yield* io.say("Cannot use those notification settings. Check the topic and dashboard URL.").pipe(Effect.as(1 as const));
  }

  if (request.dryRun) return yield* io.say("Dry run. No notification settings were saved.").pipe(Effect.as(0 as const));

  if (yield* yesNo(io, "Save notification settings", false)) {
    yield* saveNtfySettings(root, saved.revision, update);
    yield* io.say("Notification settings saved. No test was sent.");
  } else yield* io.say("No notification settings were saved.");

  return 0 as const;
}).pipe(Effect.catchTags({
  InterviewCancelled: () => io.say("Stopped. No notification settings were saved.").pipe(Effect.as(130 as const)),
  ProfileError: () => io.say("Cannot read the installation root.").pipe(Effect.as(1 as const)),
  NtfySettingsError: () => io.say("Cannot use local notification settings. Check file access and reload before trying again.").pipe(Effect.as(1 as const)),
}));
