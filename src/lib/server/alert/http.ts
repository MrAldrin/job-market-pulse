import { Effect, Layer, Predicate, Redacted } from "effect";
import { request } from "node:https";
import { DiscordHttp, DISCORD_BODY, endpoint, type DiscordResponse } from "./discord.ts";

// Inert until post(). Native HTTPS preserves the connection/submission distinction.
// There is no proxy, redirect handling, or retry.
export const DiscordHttpLive = Layer.succeed(DiscordHttp, DiscordHttp.of({
  post: (destination, timeoutSeconds) => Effect.async<DiscordResponse, { readonly phase: "connect" | "submitted" }>((resume) => {
    const target = endpoint(Redacted.value(destination));

    if (!target) {
      resume(Effect.fail({ phase: "connect" }));

      return;
    }

    let submitted = false;
    let finished = false;
    let req: ReturnType<typeof request> | undefined;

    const finish = (result: Effect.Effect<DiscordResponse, { readonly phase: "connect" | "submitted" }>) => {
      if (finished) return;
      finished = true;
      req?.destroy();
      resume(result);
    };

    try {
      req = request({
        hostname: target.host, port: target.port, path: target.target, method: "POST", agent: false,
        rejectUnauthorized: true, timeout: timeoutSeconds * 1000,
        headers: { Accept: "application/json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(DISCORD_BODY) },
      }, (response) => {
        const status = response.statusCode ?? 0;
        const retryAfter = Predicate.isString(response.headers["retry-after"]) ? response.headers["retry-after"] : null;

        if (status < 200 || status >= 300) {
          finish(Effect.succeed({ status, body: new Uint8Array(), retryAfter }));
          response.destroy();

          return;
        }

        const chunks: Uint8Array[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;

          if (size <= 16385) chunks.push(chunk);
          else finish(Effect.succeed({ status: response.statusCode ?? 0, body: new Uint8Array(16385), retryAfter: null }));
        });
        response.on("end", () => finish(Effect.succeed({
          status: response.statusCode ?? 0, body: Buffer.concat(chunks),
          retryAfter: Predicate.isString(response.headers["retry-after"]) ? response.headers["retry-after"] : null,
        })));
        response.on("error", () => finish(Effect.fail({ phase: "submitted" })));
        response.on("aborted", () => finish(Effect.fail({ phase: "submitted" })));
      });
      req.on("socket", (socket) => socket.once("secureConnect", () => {
        // From this point any error is uncertain, including a synchronous end failure.
        submitted = true;

        try { req?.end(DISCORD_BODY); }
        catch { finish(Effect.fail({ phase: "submitted" })); }
      }));
      req.on("timeout", () => req?.destroy(new Error("timeout")));
      req.on("error", () => finish(Effect.fail({ phase: submitted ? "submitted" : "connect" })));
    } catch { finish(Effect.fail({ phase: submitted ? "submitted" : "connect" })); }

    return Effect.sync(() => {
      finished = true;
      req?.destroy();
    });
  }),
}));
