import { Effect, Either, Predicate } from "effect";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { DashboardError } from "./errors.ts";

export const VIEWER_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-3yL3uEuz0XoDldm4c62qP1/b2oPsm2Bb9rheVGWpjKs=' 'sha256-2nH/lyAAxXyC8tFRH4ZEEIoJllB7IbrSSRpQuOFGqyk=' 'sha256-9LRImpH1SBVMudYqdJa+IUN+MoL0foi3w7+PJ7Y88us='; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function viewerResponse(body: string | Uint8Array, status: number, type = "text/html; charset=utf-8", extra?: HeadersInit, head = false, csp = VIEWER_CSP): Response {
  const bytes = new Uint8Array(Predicate.isString(body) ? new TextEncoder().encode(body) : body);
  const headers = new Headers(extra);

  headers.set("Content-Type", type);
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", csp);

  return new Response(head ? null : bytes, { status, headers });
}

export const textResponse = (body: string, status: number, head = false) =>
  viewerResponse(body, status, "text/plain; charset=utf-8", undefined, head);

export const jsonResponse = (body: string | Uint8Array, head = false) =>
  viewerResponse(body, 200, "application/json; charset=utf-8", undefined, head);

export const readRequestBytes = (request: Request, maximum: number) => Effect.tryPromise({
  try: async (signal) => {
    const reader = request.body?.getReader();

    if (!reader) return new Uint8Array();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    const chunks: Uint8Array[] = [];
    let size = 0;

    signal.addEventListener("abort", cancel, { once: true });

    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) break;

        size += chunk.value.byteLength;

        if (size > maximum) {
          cancel();

          return null;
        }

        chunks.push(chunk.value);
      }

      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

      return bytes;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  },
  catch: () => new DashboardError({ message: "Request body unavailable" }),
}).pipe(Effect.timeout("5 seconds"));

export const readViewerJson = (request: Request, limit: number) => Effect.gen(function* () {
  const length = request.headers.get("content-length") ?? "";
  const bad = textResponse("Bad request", 400);
  const many = textResponse("Request body too large", 413);

  if (!/^[0-9]{1,10}$/.test(length) || ["transfer-encoding", "content-encoding", "expect", "trailer"].some((header) => request.headers.has(header))) return yield* Effect.fail(bad);

  if (Number(length) > limit) return yield* Effect.fail(many);

  if (request.headers.get("content-type")?.toLowerCase() !== "application/json") return yield* Effect.fail(bad);
  const body = yield* readRequestBytes(request, limit).pipe(Effect.mapError(() => bad));

  if (body === null) return yield* Effect.fail(many);

  if (body.byteLength !== Number(length)) return yield* Effect.fail(bad);

  return yield* Either.mapLeft(parseStrictContractBytes(body, limit), () => bad);
});
