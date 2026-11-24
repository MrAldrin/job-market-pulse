import { Effect, Either, Redacted } from "effect";
import { timingSafeEqual } from "node:crypto";
import { LocalRunStart, localRunStartPath, localRunStatusPath } from "../../contracts/local-run.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { csrfWriteAuthorized, type DashboardScheme } from "./auth.ts";
import { jsonResponse, readViewerJson, textResponse, viewerResponse } from "./response.ts";
import type { DashboardRun } from "./run.ts";

const decodeStart = decodeStrict(LocalRunStart);

export const desktopClosePath = "/app/run/desktop-close";

export const desktopCloseResponse = (request: Request, url: URL, token: Redacted.Redacted<string>, run: NonNullable<DashboardRun["Type"]>) => Effect.gen(function* () {
  if (url.href !== url.origin + desktopClosePath) return textResponse("Not found", 404, request.method === "HEAD");

  if (request.method !== "POST" && request.method !== "DELETE") return textResponse("Method not allowed", 405, request.method === "HEAD");
  const supplied = Buffer.from(request.headers.get("x-pulse-desktop-token") ?? "");
  const expected = Buffer.from(Redacted.value(token));

  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return textResponse("Forbidden", 403);
  const sequence = Number(request.headers.get("x-pulse-close-sequence"));

  if (!Number.isSafeInteger(sequence) || sequence < 1) return textResponse("Invalid close sequence", 400);
  const preparing = request.method === "POST";
  const active = yield* run.setClosing(sequence, preparing);

  if (active === null) return textResponse("Stale close request", 409);

  return preparing && active ? textResponse("", 200) : new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

export const localRunResponse = (request: Request, url: URL, csrf: string, scheme: DashboardScheme, run: NonNullable<DashboardRun["Type"]>) => Effect.gen(function* () {
  const head = request.method === "HEAD";

  if (url.href !== url.origin + url.pathname) return textResponse("Not found", 404, head);

  if (url.pathname === localRunStatusPath) {
    if (request.method !== "GET" && !head) return textResponse("Method not allowed", 405);
    const current = yield* run.status;

    return current === null ? textResponse("Run status unavailable", 503, head)
      : jsonResponse(JSON.stringify({ ...current, csrf_token: csrf }), head);
  }

  if (url.pathname !== localRunStartPath) return textResponse("Not found", 404, head);

  if (request.method !== "POST") return textResponse("Method not allowed", 405, head);

  if (!csrfWriteAuthorized(request, csrf, scheme)) return textResponse("Forbidden", 403);

  const raw = yield* readViewerJson(request, 128);

  const decoded = decodeStart(raw);

  if (Either.isLeft(decoded)) return textResponse("Confirm the refresh before starting it", 400);
  const admission = yield* run.start(decoded.right.reset_run_id ?? null);

  if (admission === "closing") return textResponse("The app is closing", 409);

  if (admission === "busy") return textResponse("A run is already in progress", 409);

  if (admission === "changed") return textResponse("The saved run changed. Check the run status and confirm again.", 409);

  if (admission === "unavailable") return textResponse("Cannot start the refresh", 503);

  return viewerResponse("", 202, "text/plain; charset=utf-8");
}).pipe(Effect.catchAll(Effect.succeed));
