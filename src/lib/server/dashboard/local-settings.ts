import { Context, Effect, Either, Layer } from "effect";
import { localSettingsPath, LocalSettingsPost } from "../../contracts/local-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { NtfyTransport, testNtfyMessage } from "../alert/ntfy.ts";
import { readNtfySettings, withNtfySettingsLock } from "../profile/ntfy-settings.ts";
import type { LocalProfileSettings, LocalSettingsError, LocalSettingsTarget } from "../profile/local-settings.ts";
import type { ModelPickerError } from "../judge/model-picker.ts";
import { csrfWriteAuthorized, type DashboardScheme } from "./auth.ts";
import { jsonResponse, readViewerJson, textResponse } from "./response.ts";

const decodePost = decodeStrict(LocalSettingsPost);

const failureResponse = (error: LocalSettingsError | ModelPickerError, head: boolean) => {
  switch (error.code) {
    case "invalid": return textResponse(error instanceof Error && error.message ? error.message : "Invalid settings update", 400, head);
    case "changed": return textResponse("Settings changed. Reload before saving again.", 409, head);
    case "busy": return textResponse("Another operation is using the installation. Try again later.", 409, head);
    case "unavailable": return textResponse("Current local settings unavailable", 503, head);
    case "pi_missing": return textResponse("Could not find Pi on PATH.", 503, head);
    case "discovery_failed": return textResponse("Pi did not return a usable model list. The last saved list did not change.", 502, head);
    case "harness_missing": return textResponse("Could not find the selected harness on PATH.", 503, head);
    case "test_timeout": return textResponse("The model test timed out.", 504, head);
    case "test_failed": return textResponse("The harness did not return a valid result for this model. Check the model and harness login.", 502, head);
    case "wrong_reply": return textResponse("The model replied, but did not return the expected test reply.", 502, head);
  }
};

export class DashboardNtfyTest extends Context.Tag("pulse/DashboardNtfyTest")<DashboardNtfyTest, {
  readonly send: (root: string, revision: string) => Effect.Effect<Response>;
}>() {}

export const DashboardNtfyTestLive = Layer.effect(DashboardNtfyTest, Effect.gen(function* () {
  const transport = yield* NtfyTransport;
  const context = yield* Effect.context<Effect.Effect.Context<ReturnType<typeof readNtfySettings>>>();

  return DashboardNtfyTest.of({ send: (root, revision) => withNtfySettingsLock(root, Effect.gen(function* () {
    const { topic, revision: current } = yield* readNtfySettings(root);

    if (revision !== current) return textResponse("Settings changed. Reload before sending a test.", 409);

    if (topic === null) return textResponse("Save a topic before sending a test.", 400);
    const posted = yield* transport.post(topic, testNtfyMessage);

    return posted ? jsonResponse(JSON.stringify({ ok: true })) : textResponse("Could not send the test notification.", 502);
  })).pipe(
    Effect.provide(context),
    Effect.catchAll(({ code }) => Effect.succeed(code === "busy"
      ? textResponse("Another operation is using the installation. Try again later.", 409)
      : textResponse("Notification settings unavailable.", 503))),
  ) });
}));

export const localSettingsResponse = (
  request: Request, url: URL, target: LocalSettingsTarget, csrf: string, scheme: DashboardScheme, settings: LocalProfileSettings["Type"], test: DashboardNtfyTest["Type"] | null,
) => Effect.gen(function* () {
  const head = request.method === "HEAD";

  if (url.href !== url.origin + localSettingsPath) return textResponse("Not found", 404, head);

  if (request.method === "GET" || head) {
    const current = yield* settings.read(target);

    return jsonResponse(JSON.stringify({ ...current, csrf_token: csrf }), head);
  }

  if (request.method !== "POST") return textResponse("Method not allowed", 405);

  if (!csrfWriteAuthorized(request, csrf, scheme)) return textResponse("Forbidden", 403);
  const raw = yield* readViewerJson(request, 256 * 1024);
  const update = yield* Either.mapLeft(decodePost(raw), () => textResponse("Invalid settings update", 400));

  if (update.kind === "refresh_models") {
    const catalog = yield* settings.refreshModels(target);

    return jsonResponse(JSON.stringify(catalog));
  }

  if (update.kind === "test_model") {
    yield* settings.testModel(target, update);

    return jsonResponse(JSON.stringify({ ok: true }));
  }

  if (update.kind === "test_notification") {
    return test === null ? textResponse("Notification test unavailable.", 503) : yield* test.send(target.root, update.revision);
  }

  const saved = yield* settings.save(target, update);

  return jsonResponse(JSON.stringify(saved));
}).pipe(Effect.catchAll((error) => Effect.succeed(error instanceof Response ? error : failureResponse(error, request.method === "HEAD"))));
