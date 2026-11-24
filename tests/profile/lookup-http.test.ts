import { FetchHttpClient, HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Either, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { allowedLookupUrl, decodeLookupText, LookupHttp, LookupHttpLive } from "../../src/lib/server/profile/lookup-http.ts";

const endpoint = "https://api.kartverket.no/stedsnavn/v1/sted";

const fixture = (chunks: readonly Uint8Array[] = [new TextEncoder().encode("{}")], status = 200, never = false) => {
  const calls: { url: string; accept: string | undefined; redirect: string | undefined; trace: string | undefined }[] = [];
  let cancelled = false;

  const client = HttpClient.make((request, url) => Effect.gen(function* () {
    const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
    calls.push({ url: String(url), accept: request.headers.accept, trace: request.headers.traceparent, redirect: Option.isSome(init) ? init.value.redirect : undefined });

    if (never) return yield* Effect.never;

    const iterator = chunks[Symbol.iterator]();

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const value = iterator.next();

        if (value.done) controller.close();
        else controller.enqueue(value.value);
      },
      cancel() { cancelled = true; },
    });

    return HttpClientResponse.fromWeb(request, new Response(stream, { status }));
  }));

  const layer = LookupHttpLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

  const get = (url = endpoint, maximum = 65_536, timeout = 10_000) => Effect.gen(function* () {
    const http = yield* LookupHttp;

    return yield* http.get(url, "application/json", maximum, timeout);
  }).pipe(Effect.provide(layer));

  return { get, calls, cancelled: () => cancelled };
};

describe("bounded injected HTTP resource", () => {
  it.each([endpoint, endpoint + "?sok=Invented", "https://ws.geonorge.no/adresser/v1/sok", "https://wfs.geonorge.no/skwms1/wfs.postnummeromrader?count=2"])("allows only selected exact public endpoint %s", async (url) => {
    const transport = fixture();
    expect(new TextDecoder().decode(await Effect.runPromise(transport.get(url)))).toBe("{}");
    expect(transport.calls).toEqual([{ url, accept: "application/json", trace: undefined, redirect: "manual" }]);
  });
  it.each(["http://api.kartverket.no/stedsnavn/v1/sted", endpoint + "/", endpoint + "#fragment", "https://api.kartverket.no:443/stedsnavn/v1/sted", "https://user@api.kartverket.no/stedsnavn/v1/sted", "https://api.kartverket.no.invalid/stedsnavn/v1/sted", "https://API.KARTVERKET.NO/stedsnavn/v1/sted", "https://api.kartverket.no/other/../stedsnavn/v1/sted", "file:///tmp/local"])("rejects endpoint before any HTTP %s", async (url) => {
    const transport = fixture();
    expect(allowedLookupUrl(url)).toBe(false);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(transport.get(url))))).toBe(true);
    expect(transport.calls).toEqual([]);
  });
  it.each([301, 302, 307, 308, 404, 500])("refuses status %s without following Location", async (status) => {
    const transport = fixture([new TextEncoder().encode("SYNTHETIC PRIVATE BODY")], status);
    const result = await Effect.runPromise(Effect.either(transport.get(endpoint + "?sok=SYNTHETIC_QUERY")));
    expect(Either.isLeft(result)).toBe(true);
    expect(transport.calls).toHaveLength(1);

    if (Either.isLeft(result)) expect(result.left.message).toBe("Place lookup failed");
  });
  it("counts streamed bytes, accepts the exact boundary and interrupts an oversize body", async () => {
    const exact = fixture([new Uint8Array(4096), new Uint8Array(61_440)]);
    expect((await Effect.runPromise(exact.get())).byteLength).toBe(65_536);
    const overflow = fixture([new Uint8Array(65_536), new Uint8Array(1), new Uint8Array(100)]);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(overflow.get())))).toBe(true);
    expect(overflow.cancelled()).toBe(true);
    expect(Either.isLeft(decodeLookupText(new Uint8Array([255])))).toBe(true);
  });
  it("validates finite time and byte budgets before touching transport", async () => {
    const transport = fixture();

    for (const [maximum, timeout] of [[-1, 10], [65_537, 10], [Number.NaN, 10], [1, 0], [1, Number.POSITIVE_INFINITY], [1, Number.NaN]]) expect(Either.isLeft(await Effect.runPromise(Effect.either(transport.get(endpoint, maximum, timeout))))).toBe(true);

    expect(transport.calls).toEqual([]);
  });
  it("uses the injected Clock for timeout and interrupts a stalled request", async () => {
    const transport = fixture([], 200, true);

    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.either(transport.get(endpoint, 65_536, 10)));
      yield* TestClock.adjust("11 millis");

      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)));

    expect(Either.isLeft(result)).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });
});
