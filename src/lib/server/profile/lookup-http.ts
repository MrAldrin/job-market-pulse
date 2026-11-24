import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema, Stream } from "effect";
import { PlaceLookupError } from "./errors.ts";

export class LookupHttp extends Context.Tag("pulse/LookupHttp")<LookupHttp, {
  readonly get: (url: string, accept: string, maximum: number, timeoutMillis: number) => Effect.Effect<Uint8Array, PlaceLookupError>;
}>() {}

const endpoints = new Set([
  "https://api.kartverket.no/stedsnavn/v1/sted",
  "https://ws.geonorge.no/adresser/v1/sok",
  "https://wfs.geonorge.no/skwms1/wfs.postnummeromrader",
]);

// Compare the supplied authority before URL canonicalization can erase an explicit port.
export const allowedLookupUrl = (url: string): boolean => {
  if (!Schema.is(Schema.String)(url)) return false;

  const prefix = url.split("?")[0] ?? "";

  return endpoints.has(prefix) && !url.includes("#");
};

const validBudget = Schema.is(Schema.Struct({
  maximum: Schema.Int.pipe(Schema.between(0, 65_536)),
  timeoutMillis: Schema.Number.pipe(Schema.finite(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(10_000)),
}));

export const LookupHttpLive = Layer.effect(LookupHttp, Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withTracerPropagation(false), HttpClient.withTracerDisabledWhen(() => true));

  return {
    get: (url: string, accept: string, maximum: number, timeoutMillis: number) => Effect.gen(function* () {
      if (!allowedLookupUrl(url)) return yield* new PlaceLookupError({ message: "Lookup endpoint is not allowed" });

      if (!validBudget({ maximum, timeoutMillis })) return yield* new PlaceLookupError({ message: "Lookup exceeded bounds" });

      const response = yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("Accept", accept)));

      if (response.status !== 200) return yield* new PlaceLookupError({ message: "Place service returned an error" });

      let size = 0;
      const chunks: Uint8Array[] = [];
      yield* response.stream.pipe(Stream.runForEach((chunk) => {
        size += chunk.byteLength;

        if (size > maximum) return Effect.fail(new PlaceLookupError({ message: "Place response exceeded bounds" }));

        chunks.push(chunk);

        return Effect.void;
      }));
      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return bytes;
    }).pipe(
      Effect.timeoutFail({ duration: timeoutMillis, onTimeout: () => new PlaceLookupError({ message: "Place lookup failed" }) }),
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(() => new PlaceLookupError({ message: "Place lookup failed" })),
    ),
  };
}));

export const decodeLookupText = (bytes: Uint8Array) => Either.try({
  try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  catch: () => new PlaceLookupError({ message: "Invalid place response" }),
});
