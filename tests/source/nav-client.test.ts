import { FetchHttpClient, HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Either, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { apiUrl, ORIGIN } from "../../src/lib/server/source/core.ts";
import { SourceError } from "../../src/lib/server/source/errors.ts";
import { monotonicMillis, NavClient, NavClientLive, SourceHttp, SourceHttpLive, transientNetworkError, type WireResponse } from "../../src/lib/server/source/nav-client.ts";

const path = "/api/v1/feed/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const bytes = (text: string) => new TextEncoder().encode(text);
const response = (body: string, status = 200): WireResponse => ({ status, bytes: bytes(body), headers: { etag: "synthetic" } });

const nav = (replies: readonly (WireResponse | SourceError)[]) => {
  const pending = [...replies];
  const calls: { url: string; headers: Readonly<Record<string, string>>; maximum: number; timeout: number; deadline: number }[] = [];

  const http = Layer.succeed(SourceHttp, { request: (url, headers, maximum, timeout, deadline) => {
    calls.push({ url, headers, maximum, timeout, deadline });
    const value = pending.shift();

    if (value === undefined) return Effect.die("Unexpected synthetic request");

    return value instanceof SourceError ? Effect.fail(value) : Effect.succeed(value);
  } });

  return { layer: NavClientLive.pipe(Layer.provide(http)), calls };
};

const wire = (chunks: readonly Uint8Array[], status = 200, stalled = false) => {
  let cancelled = false;
  const calls: { url: string; redirect: string | undefined; trace: string | undefined }[] = [];

  const client = HttpClient.make((request, url) => Effect.gen(function* () {
    const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
    calls.push({ url: String(url), redirect: Option.isSome(init) ? init.value.redirect : undefined, trace: request.headers.traceparent });

    if (stalled) return yield* Effect.never;
    const iterator = chunks[Symbol.iterator]();

    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      const next = iterator.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    }, cancel() { cancelled = true; } });

    return HttpClientResponse.fromWeb(request, new Response(stream, { status, headers: { location: "https://attacker.test/never" } }));
  }));

  const get = (maximum = 2_000_000, timeout = 15_000, target = ORIGIN + path) => Effect.gen(function* () {
    return yield* (yield* SourceHttp).request(target, {}, maximum, timeout, (yield* monotonicMillis) + 90_000);
  }).pipe(Effect.provide(SourceHttpLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))));

  return { get, calls, cancelled: () => cancelled };
};

describe("Source API destinations", () => {
  it.each([path, ORIGIN + path, "//pam-stilling-feed.nav.no" + path, "HTTPS://pam-stilling-feed.nav.no" + path, "./api/v1/unused/../feed/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]) ("resolves the frozen public route %s", (input) => expect(Either.getOrThrow(apiUrl(input, "page"))).toBe(ORIGIN + path));
  it.each(["http://pam-stilling-feed.nav.no" + path, ORIGIN + ":443" + path, "https://user@pam-stilling-feed.nav.no" + path, "https://PAM-STILLING-FEED.NAV.NO" + path, "//attacker.test" + path, path + "#private", path + "?secret", path + "/more", "/api/v1/feed?next=x", "https://pam-stilling-feed.nav.no.invalid" + path])("rejects route %s", (input) => expect(Either.isLeft(apiUrl(input, "page"))).toBe(true));
});

describe("real NAV client with only external HTTP replaced", () => {
  it("gets one public token, reuses it, forwards validators and retains raw numeric identity", async () => {
    const test = nav([response("prefix eyJsynthetic.payload.signature suffix"), response('{"integer":1,"float":1.0,"flag":true}'), response("", 304)]);

    const result = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* (yield* NavClient).session();
      const first = yield* client.get(path, "page", { "If-None-Match": "prior" });
      const second = yield* client.get(path, "page");

      return { first, second, requests: client.requests, remaining: client.remaining, details: client.details_remaining };
    }).pipe(Effect.provide(test.layer)));

    expect(result).toEqual({ first: [{ integer: 1n, float: 1, flag: true }, { etag: "synthetic" }], second: [null, { etag: "synthetic" }], requests: 3, remaining: 27, details: 10 });
    expect(test.calls[0]?.url).toBe(ORIGIN + "/api/publicToken");
    expect(test.calls[1]?.headers).toEqual({ Accept: "application/json", Authorization: "Bearer eyJsynthetic.payload.signature", "If-None-Match": "prior" });
    expect(test.calls.every((call) => call.maximum === 2_000_000 && call.timeout <= 15_000)).toBe(true);
  });
  it("counts token in request budget and does not acquire it for a rejected route", async () => {
    const test = nav([response("eyJsynthetic.payload.signature")]);
    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* (yield* NavClient).session({ maxRequests: 1, seconds: 90 });
      expect(Either.isLeft(yield* Effect.either(client.get("https://attacker.test", "page")))).toBe(true);
      expect(client.requests).toBe(0);
      const result = yield* Effect.either(client.get(path, "page"));
      expect(Either.isLeft(result) && result.left.transient).toBe(true);
      expect(client.requests).toBe(1);
    }).pipe(Effect.provide(test.layer)));
    expect(test.calls).toHaveLength(1);
  });
  it.each([[429, true], [500, true], [599, true], [301, false], [401, false], [404, false]])("classifies status %s without body or token disclosure", async (status, transient) => {
    const test = nav([response("eyJsynthetic.payload.signature"), response("SYNTHETIC_PRIVATE_BODY", Number(status))]);
    const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* (yield* NavClient).session()).get(path, "page"); }).pipe(Effect.provide(test.layer), Effect.either));
    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left.transient).toBe(transient);
      expect(result.left.message).not.toContain("PRIVATE");
      expect(result.left.message).not.toContain("eyJ");
    }
  });
  it.each([response("[]"), response("bad json"), { status: 200, bytes: new Uint8Array([255]), headers: {} }])("rejects invalid response data", async (reply) => {
    const test = nav([response("eyJsynthetic.payload.signature"), reply]);
    expect(Either.isLeft(await Effect.runPromise(Effect.gen(function* () { return yield* (yield* (yield* NavClient).session()).get(path, "page"); }).pipe(Effect.provide(test.layer), Effect.either)))).toBe(true);
  });
  it("uses injected time for the 90-second session ceiling", async () => {
    const test = nav([]);
    await Effect.runPromise(Effect.gen(function* () {
      const start = yield* monotonicMillis;
      const client = yield* (yield* NavClient).session();
      expect(client.deadline - start).toBe(90_000);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Effect.either(client.get(path, "page"));
      expect(Either.isLeft(result) && result.left.transient).toBe(true);
      expect(client.requests).toBe(0);
    }).pipe(Effect.provide(test.layer), Effect.provide(TestContext.TestContext)));
    expect(test.calls).toEqual([]);
  });
  it("distinguishes resets/busy DNS from TLS, bad name and bad values", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"]) expect(transientNetworkError({ cause: { code } })).toBe(true);

    for (const code of ["ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_INVALID_URL"]) expect(transientNetworkError({ cause: { code } })).toBe(false);

    interface FailureNode { cause?: FailureNode }

    const circular: FailureNode = {};
    circular.cause = circular;
    expect(transientNetworkError(circular)).toBe(false);
  });
});

describe("bounded streamed Source HTTP resource", () => {
  it("accepts exact bytes and cancels a larger response without redirects or traces", async () => {
    const exact = wire([new Uint8Array(1_000_000), new Uint8Array(1_000_000)]);
    expect((await Effect.runPromise(exact.get())).bytes.length).toBe(2_000_000);
    expect(exact.calls).toEqual([{ url: ORIGIN + path, redirect: "manual", trace: undefined }]);
    const overflow = wire([new Uint8Array(2_000_000), new Uint8Array(1), new Uint8Array(100)]);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(overflow.get())))).toBe(true);
    expect(overflow.cancelled()).toBe(true);
    const redirect = wire([], 302);
    expect((await Effect.runPromise(redirect.get())).status).toBe(302);
    expect(redirect.calls).toHaveLength(1);
  });
  it("rejects invalid destinations/budgets before transport", async () => {
    const test = wire([]);

    for (const [maximum, timeout] of [[-1, 10], [2_000_001, 10], [1, 0], [NaN, 10], [1, Infinity]]) {
      const result = await Effect.runPromise(Effect.either(test.get(maximum, timeout)));
      expect(Either.isLeft(result)).toBe(true);
    }

    expect(Either.isLeft(await Effect.runPromise(Effect.either(test.get(1, 10, "https://attacker.test/"))))).toBe(true);
    expect(test.calls).toEqual([]);
  });
  it("interrupts a stalled body using TestClock", async () => {
    const test = wire([], 200, true);

    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.either(test.get(100, 10)));
      yield* TestClock.adjust("11 millis");

      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)));

    expect(Either.isLeft(result) && result.left.transient).toBe(true);
  });
});
