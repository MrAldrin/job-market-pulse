import { Clock, Context, Effect, Layer, Option } from "effect";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { localRunStartPath, localRunStatusPath } from "../../contracts/local-run.ts";
import { localSettingsPath } from "../../contracts/local-settings.ts";
import { LocalProfileSettings } from "../profile/local-settings.ts";
import {
  clientAddress, createLoginLimiter, credentialsMatch, feedbackSession, isLoopback, isProxyRequest, LOGIN_ERROR, loginPage,
  safeNext, SESSION_MAX_AGE_SECONDS, sessionCookie, sessionIsValid, signSession, type DashboardScheme,
} from "./auth.ts";
import { DashboardConfig, type DashboardSettings } from "./config.ts";
import { isFeedbackPath, shortlistFeedback } from "./feedback.ts";
import { DashboardNtfyTest, localSettingsResponse } from "./local-settings.ts";
import { DashboardRun } from "./run.ts";
import { desktopClosePath, desktopCloseResponse, localRunResponse } from "./run-response.ts";
import { LOGIN_CSP, readRequestBytes, textResponse, viewerResponse } from "./response.ts";
import { settingsSuggestionsPath } from "../../contracts/settings-suggestions.ts";
import { DashboardSettingsSuggestions, settingsSuggestionResponse } from "./settings-suggestions.ts";
import { DashboardSnapshot } from "./snapshot.ts";
import { bearerExportResponse, isBearerExportPath } from "./bearer-exports.ts";

function loginFormResponse(next: string, head: boolean, error?: string): Response {
  const response = viewerResponse(loginPage(next, error), error === undefined ? 200 : 401, undefined, undefined, head, LOGIN_CSP);

  // Chromium otherwise sends Origin: null on a same-origin form navigation.
  response.headers.set("Referrer-Policy", "same-origin");

  return response;
}

const redirect = (path: string, head: boolean, cookie?: string) => {
  const headers = new Headers({ Location: path });

  if (cookie) headers.set("Set-Cookie", cookie);

  return viewerResponse("", 303, "text/html; charset=utf-8", headers, head);
};

function sessionAuthorized(config: DashboardSettings, request: Request, now: number): boolean {
  const login = config.login;

  if (!login) return false;

  return (request.headers.get("cookie") ?? "").split(";").some((part) => {
    const separator = part.indexOf("=");

    return separator >= 0 && part.slice(0, separator).trim() === "jmp_session" && sessionIsValid(part.slice(separator + 1).trim(), login.sessionKey, now);
  });
}

function formFields(bytes: Uint8Array): Map<string, string> {
  try {
    const pairs = [...new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes))];

    return pairs.length <= 16 ? new Map(pairs) : new Map();
  } catch {
    return new Map();
  }
}

export interface DashboardRequest {
  readonly request: Request;
  // The owning adapter supplies only native socket identity, never a header.
  readonly socketAddress: string;
  // Only set for the Kit /app page data request, after Kit strips its parameters.
  readonly kitAppDataSearch?: string | undefined;
}

function localScheme(config: DashboardSettings, { request, socketAddress }: DashboardRequest): DashboardScheme | null {
  if (config.mode !== "local" || !isLoopback(socketAddress)) return null;
  const host = request.headers.get("host");
  const serve = config.serve;

  if (serve !== undefined && host === serve.host) {
    const origin = request.headers.get("origin");

    // Serve strips client-supplied identity and sets its own login. The
    // forwarding marker is not identity; it also keeps proxies out of the
    // ordinary direct-loopback path, even if they send a local Host.
    return request.headers.has("x-forwarded-for")
      && request.headers.get("x-forwarded-proto") === "https"
      && request.headers.get("tailscale-user-login") === serve.owner
      && URL.parse(request.url)?.origin === serve.origin
      && (origin === null || origin === serve.origin) ? "https" : null;
  }

  return host !== null && config.allowedHosts.includes(host) && !isProxyRequest(request.headers) ? "http" : null;
}

export class DashboardServer extends Context.Tag("pulse/DashboardServer")<DashboardServer, {
  readonly settings: DashboardSettings;
  readonly capabilities: (input: DashboardRequest) => { canGiveFeedback: boolean; canEditSettings: boolean; canRunRefresh: boolean };
  readonly handle: (input: DashboardRequest) => Effect.Effect<Response | undefined>;
}>() {}

export const DashboardServerLive = Layer.effect(DashboardServer, Effect.gen(function* () {
  const config = yield* DashboardConfig;
  const snapshot = yield* DashboardSnapshot;
  const profileSettings = yield* LocalProfileSettings;
  const limiter = createLoginLimiter();
  const localCsrf = config.mode === "local" ? randomBytes(32).toString("hex") : undefined;
  const target = config.mode === "local" ? config.localSettings : undefined;
  const settingsCsrf = target === undefined ? undefined : randomBytes(32).toString("hex");
  const suggestions = target === undefined ? null : Option.getOrNull(yield* Effect.serviceOption(DashboardSettingsSuggestions));
  const testNotification = target === undefined ? null : Option.getOrNull(yield* Effect.serviceOption(DashboardNtfyTest));
  const run = target === undefined ? null : Option.getOrNull(yield* Effect.serviceOption(DashboardRun));
  const runCsrf = run === null ? undefined : randomBytes(32).toString("hex");
  const feedback = config.mode === "local" ? shortlistFeedback(config, snapshot) : null;

  const capabilities = (input: DashboardRequest) => {
    const local = localScheme(config, input) !== null;

    return {
      // The page gate also admits signed local viewer sessions.
      canGiveFeedback: feedback !== null && config.feedbackProfile !== null,
      canEditSettings: local && target !== undefined,
      canRunRefresh: local && run !== null,
    };
  };

  const handle = (input: DashboardRequest) => Effect.gen(function* () {
    const { request, socketAddress } = input;
    const url = new URL(request.url);
    const head = request.method === "HEAD";
    const path = url.pathname;

    if (path === "/healthz" && !url.search && (request.method === "GET" || head)) return undefined;

    const host = request.headers.get("host");

    const scheme = localScheme(config, input);
    const serveHost = config.mode === "local" && config.serve !== undefined && host === config.serve.host;
    const proxyIngress = config.mode === "local" && (serveHost || (isLoopback(socketAddress) && isProxyRequest(request.headers)));

    if (!host || /[,\s/\\?#@]/.test(host)
      || (!serveHost && config.allowedHosts.length > 0 && !config.allowedHosts.includes(host))
      || (proxyIngress && scheme !== "https")) {
      return isBearerExportPath(path) ? textResponse("Forbidden", 403, head) : viewerResponse("", 403, undefined, undefined, head);
    }

    if (path === localSettingsPath) {
      return target !== undefined && settingsCsrf !== undefined && scheme !== null
        ? yield* localSettingsResponse(request, url, target, settingsCsrf, scheme, profileSettings, testNotification)
        : textResponse("Not found", 404, head);
    }

    if (path === settingsSuggestionsPath) {
      return suggestions !== null && settingsCsrf !== undefined && scheme !== null
        ? yield* settingsSuggestionResponse(request, url, settingsCsrf, scheme, suggestions)
        : textResponse("Not found", 404, head);
    }

    if (path === desktopClosePath) {
      return run !== null && config.desktopCloseToken !== undefined && scheme === "http"
        ? yield* desktopCloseResponse(request, url, config.desktopCloseToken, run)
        : textResponse("Not found", 404, head);
    }

    if (path === localRunStartPath || path === localRunStatusPath) {
      return run !== null && runCsrf !== undefined && scheme !== null
        ? yield* localRunResponse(request, url, runCsrf, scheme, run)
        : textResponse("Not found", 404, head);
    }

    if (isBearerExportPath(path)) return config.mode === "local"
      ? yield* bearerExportResponse(config, request, url, path)
      : textResponse("Not found", 404, head);

    if (isFeedbackPath(path) && feedback === null) return textResponse("Not found", 404, head);

    const now = yield* Clock.currentTimeMillis;
    const seconds = Math.floor(now / 1000);
    const login = config.login;

    if (path === "/login" && (request.method === "GET" || head)) {
      if (!login) return scheme !== null ? redirect("/", head) : viewerResponse("Viewer unavailable", 503, "text/plain; charset=utf-8", undefined, head);
      const query = [...url.searchParams];
      const next = query.length <= 8 ? new Map(query).get("next") : undefined;

      return loginFormResponse(safeNext(next), head);
    }

    if (path === "/logout" && request.method === "POST") return redirect("/login", false, sessionCookie("", 0));

    if (path === "/login" && request.method === "POST") {
      if (!login) return scheme !== null ? redirect("/", false) : viewerResponse("Viewer unavailable", 503, "text/plain; charset=utf-8");
      const lengthText = request.headers.get("content-length") ?? "";

      if (!/^[0-9]{1,10}$/.test(lengthText)) return viewerResponse("Bad request", 400, "text/plain; charset=utf-8");
      const length = Number(lengthText);

      if (length > 4096) return viewerResponse("Request body too large", 413, "text/plain; charset=utf-8");
      const claimedAddress = clientAddress(config.mode, socketAddress, request.headers);
      const rateAddress = isIP(claimedAddress) ? new URL(`http://${isIP(claimedAddress) === 6 ? `[${claimedAddress}]` : claimedAddress}/`).hostname : "unattributed";

      if (limiter.isLimited(rateAddress, now)) return viewerResponse("Too many login attempts", 429, "text/plain; charset=utf-8", { "Retry-After": "900" });
      const read = yield* readRequestBytes(request, 4096).pipe(Effect.option);

      if (Option.isNone(read)) return viewerResponse("Bad request", 400, "text/plain; charset=utf-8");

      if (read.value === null) return viewerResponse("Request body too large", 413, "text/plain; charset=utf-8");

      if (read.value.byteLength !== length) return viewerResponse("Bad request", 400, "text/plain; charset=utf-8");
      const fields = formFields(read.value);
      const next = safeNext(fields.get("next"));
      const checkedAt = yield* Clock.currentTimeMillis;

      if (limiter.isLimited(rateAddress, checkedAt)) return viewerResponse("Too many login attempts", 429, "text/plain; charset=utf-8", { "Retry-After": "900" });

      if (!credentialsMatch(login, fields.get("username") ?? "", fields.get("password") ?? "")) {
        limiter.recordFailure(rateAddress, checkedAt);
        yield* Effect.sleep("1 second");

        return loginFormResponse(next, false, LOGIN_ERROR);
      }

      limiter.clear(rateAddress);
      const cookie = sessionCookie(signSession(login.sessionKey, Math.floor(checkedAt / 1000) + SESSION_MAX_AGE_SECONDS), SESSION_MAX_AGE_SECONDS);

      return redirect(next, false, cookie);
    }

    if (isFeedbackPath(path) && feedback !== null) {
      const csrf = scheme === null ? feedbackSession(request, login, seconds) : localCsrf;

      if (csrf !== undefined) return yield* feedback(request, url, csrf, scheme ?? "https");

      return redirect(`/login?next=${encodeURIComponent(path + url.search)}`, head);
    }

    if (scheme === null && !sessionAuthorized(config, request, seconds)) {
      const next = input.kitAppDataSearch === undefined ? path + url.search : `/app/${input.kitAppDataSearch}`;

      return redirect(`/login?next=${encodeURIComponent(next)}`, head);
    }

    if (request.method !== "GET" && !head) return viewerResponse("", 405);

    if (path === "/" || path === "/app") return redirect("/app/", head);

    return undefined;
  });

  return { settings: config, capabilities, handle };
}));
