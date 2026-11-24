import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Clock, Context, Effect, Either, Layer, Schema, Stream } from "effect";
import { apiUrl, asObject, MAX_DETAILS, ORIGIN, sourceJson, type SourceObject } from "./core.ts";
import { SourceError } from "./errors.ts";
import { SUPPORTED_PROVIDER } from "../shared/workplace-fingerprint.ts";

export interface WireResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

export class SourceHttp extends Context.Tag("pulse/SourceHttp")<SourceHttp, {
  readonly request: (url: string, headers: Readonly<Record<string, string>>, maximum: number, timeoutMillis: number, deadline: number) => Effect.Effect<WireResponse, SourceError>;
}>() {}

export const monotonicMillis = Clock.currentTimeNanos.pipe(Effect.map((nanos) => Number(nanos / 1_000_000n)));
export const transientStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);
const transientCodes = new Set(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETRESET", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

const NetworkFailure = Schema.Struct({ code: Schema.optional(Schema.String), name: Schema.optional(Schema.String), cause: Schema.optional(Schema.Unknown) });

type NetworkFailure = typeof NetworkFailure.Type;

export const transientNetworkError = (error: NetworkFailure, depth = 0): boolean => {
  if (depth > 8) return false;

  if (error.code !== undefined) return transientCodes.has(error.code);

  if (error.name === "TimeoutError") return true;

  if (error.cause === undefined || error.cause === error) return false;

  const cause = Schema.decodeUnknownEither(NetworkFailure)(error.cause);

  return Either.isRight(cause) && transientNetworkError(cause.right, depth + 1);
};

// This low-level resource does not follow links or acquire credentials itself.
export const SourceHttpLive = Layer.effect(SourceHttp, Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withTracerPropagation(false), HttpClient.withTracerDisabledWhen(() => true));

  return {
    request: (url: string, headers: Readonly<Record<string, string>>, maximum: number, timeoutMillis: number, deadline: number) => Effect.gen(function* () {
      const page = apiUrl(url, "page");
      const detail = apiUrl(url, "detail");

      const allowed = url === ORIGIN + "/api/publicToken" || url.startsWith(SUPPORTED_PROVIDER + "?")
        || (Either.isRight(page) && page.right === url) || (Either.isRight(detail) && detail.right === url);

      const budget = Schema.is(Schema.Struct({ maximum: Schema.Int.pipe(Schema.between(0, 2_000_000)), timeoutMillis: Schema.Number.pipe(Schema.finite(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(15_000)), deadline: Schema.Number.pipe(Schema.finite()) }));

      if (!allowed || !budget({ maximum, timeoutMillis, deadline })) return yield* new SourceError({ message: "Rejected Source HTTP request" });

      if ((yield* monotonicMillis) >= deadline) return yield* new SourceError({ message: "Run time limit reached", transient: true });

      const response = yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)));
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(Stream.runForEach((chunk) => Effect.gen(function* () {
        if ((yield* monotonicMillis) >= deadline) return yield* new SourceError({ message: "Run time limit reached", transient: true });

        size += chunk.byteLength;

        if (size > maximum) return yield* new SourceError({ message: maximum === 2_000_000 ? "Response exceeds 2 MB limit" : "Address response exceeded bounds" });

        chunks.push(chunk);
      })));
      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

      return { status: response.status, bytes, headers: response.headers };
    }).pipe(
      Effect.timeoutFail({ duration: timeoutMillis, onTimeout: () => new SourceError({ message: "NAV request failed; retry later", transient: true }) }),
      Effect.catchAll((error) => {
        if (error instanceof SourceError) return Effect.fail(error);

        const failure = Schema.decodeUnknownEither(NetworkFailure)(error);

        return Effect.fail(new SourceError({ message: "NAV request failed; retry later", transient: Either.isRight(failure) && transientNetworkError(failure.right) }));
      }),
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  };
}));

export interface NavSession {
  remaining: number;
  requests: number;
  details_remaining: number;
  token: string | null;
  readonly deadline: number;
  readonly get: (url: string, kind: "page" | "detail", conditional?: Readonly<Record<string, string>>) => Effect.Effect<readonly [SourceObject | null, Readonly<Record<string, string>>], SourceError>;
}

export interface NavLimits { readonly maxRequests: number; readonly seconds: number }

export class NavClient extends Context.Tag("pulse/NavClient")<NavClient, {
  readonly session: (limits?: NavLimits) => Effect.Effect<NavSession, SourceError>;
}>() {}

const decodeBytes = (bytes: Uint8Array) => Effect.try({
  try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  catch: () => new SourceError({ message: "NAV returned invalid JSON" }),
});

export const NavClientLive = Layer.effect(NavClient, Effect.gen(function* () {
  const http = yield* SourceHttp;

  return {
    session: (limits: NavLimits = { maxRequests: 30, seconds: 90 }) => Effect.gen(function* () {
      if (!Schema.is(Schema.Struct({ maxRequests: Schema.Int.pipe(Schema.nonNegative()), seconds: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()) }))(limits)) return yield* new SourceError({ message: "Invalid NAV run limits" });

      const deadline = (yield* monotonicMillis) + limits.seconds * 1000;

      const session: NavSession = {
        remaining: limits.maxRequests, requests: 0, details_remaining: MAX_DETAILS, token: null, deadline,
        get: (input, kind, conditional = {}) => Effect.gen(function* () {
          const url = yield* apiUrl(input, kind);

          const request = (target: string, headers: Readonly<Record<string, string>>) => Effect.gen(function* () {
            const left = deadline - (yield* monotonicMillis);

            if (session.remaining <= 0 || left <= 0) return yield* new SourceError({ message: "Run limit reached; run again to continue", transient: true });

            session.remaining--;
            session.requests++;
            const response = yield* http.request(target, headers, 2_000_000, Math.min(15_000, left), deadline);

            if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
              return yield* new SourceError({ message: `NAV returned HTTP ${response.status}; retry later`, transient: transientStatus(response.status) });
            }

            return response;
          });

          if (session.token === null) {
            const response = yield* request(ORIGIN + "/api/publicToken", {});
            const tokenText = new TextDecoder("latin1").decode(response.bytes);
            const match = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(tokenText);

            if (!match) return yield* new SourceError({ message: "NAV public-token format not recognized" });

            session.token = match[0];
          }

          const response = yield* request(url, { Accept: "application/json", Authorization: "Bearer " + session.token, ...conditional });

          if (response.status === 304) return [null, response.headers] as const;

          const decoded = yield* decodeBytes(response.bytes).pipe(Effect.flatMap(sourceJson));
          const body = asObject(decoded);

          if (!body) return yield* new SourceError({ message: "NAV returned an unexpected response shape" });

          return [body, response.headers] as const;
        }),
      };

      return session;
    }),
  };
}));

export interface NavReplayReply {
  readonly url: string;
  readonly kind: "page" | "detail";
  readonly body: SourceObject | null;
  readonly headers?: Readonly<Record<string, string>>;
}

// Replays external replies, not product results. A mismatch is a test defect.
export const NavClientReplay = (replies: readonly NavReplayReply[], initialToken: string | null = "synthetic") => {
  const queue = [...replies];
  const calls: { url: string; kind: "page" | "detail"; conditional: Readonly<Record<string, string>> }[] = [];

  const layer = Layer.succeed(NavClient, {
    session: (limits: NavLimits = { maxRequests: 30, seconds: 90 }) => Effect.gen(function* () {
      const deadline = (yield* monotonicMillis) + limits.seconds * 1000;

      const session: NavSession = {
        remaining: limits.maxRequests, requests: 0, details_remaining: MAX_DETAILS, token: initialToken, deadline,
        get: (url, kind, conditional = {}) => Effect.sync(() => {
          const reply = queue.shift();

          if (!reply || reply.url !== url || reply.kind !== kind) throw new Error(`Unexpected synthetic NAV request: ${kind} ${url}`);

          calls.push({ url, kind, conditional });
          session.remaining--;
          session.requests++;

          return [reply.body, reply.headers ?? {}] as const;
        }),
      };

      return session;
    }),
  });

  return { layer, calls, assertConsumed: () => { if (queue.length) throw new Error("Unused synthetic NAV replies"); } };
};
