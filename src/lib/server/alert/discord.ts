import { Context, Effect, Either, Layer, Redacted, Schema } from "effect";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { isIP } from "node:net";
import type { DeliveryPayload, TransportOutcome } from "../../contracts/alert.ts";
import { AlertError } from "./errors.ts";
import { PUSH_PREVIEW } from "./core.ts";

export { PUSH_PREVIEW } from "./core.ts";

export const DISCORD_CHANNEL = "redacted_discord";
export const DISCORD_BODY = JSON.stringify({ content: `${PUSH_PREVIEW.title}\n${PUSH_PREVIEW.body}`, allowed_mentions: { parse: [] } });

export interface DestinationConfig {
  readonly profile_id: string;
  readonly channel: typeof DISCORD_CHANNEL;
  readonly destination: Redacted.Redacted<string>;
  readonly source: "local_only" | "environment";
}

export interface Endpoint { readonly host: string; readonly port: number; readonly target: string }

export const endpoint = (value: string): Endpoint | null => {
  if (!value || value.length > 2048 || Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const match = /^https:\/\/([^/?#]+)([^#]*)(?:#(.*))?$/i.exec(value);

  if (!match || match[3] || match[1]?.includes("@") || value.includes("\\")) return null;
  const authority = match[1] ?? "";
  const ipv6 = /^\[([^\]]+)\](?::([0-9]*))?$/.exec(authority);
  const parts = ipv6 ? [ipv6[1] ?? "", ipv6[2]] : authority.split(":");
  const host = (parts[0] ?? "").toLowerCase();

  if (parts[1] !== undefined && !/^[0-9]*$/.test(parts[1])) return null;
  const port = !parts[1] ? 443 : Number(parts[1]);
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

  if (parts.length > 2 || !host || host.length > 253 || (!isIP(host) && !new RegExp(`^${label}(?:\\.${label})*$`).test(host))
    || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  let target = match[2] || "/";

  if (target.startsWith("?")) target = "/" + target;

  if (!target.startsWith("/") || !/^[\x20-\x7e]*$/.test(target)) return null;
  const queryAt = target.indexOf("?");
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = queryAt < 0 ? "" : target.slice(queryAt + 1);
  const pairs = new URLSearchParams(query);

  pairs.delete("wait"); pairs.append("wait", "true");

  return { host, port, target: `${path}?${pairs.toString()}` };
};

const Preview = Schema.Struct({ title: Schema.Literal(PUSH_PREVIEW.title), body: Schema.Literal(PUSH_PREVIEW.body) });

export const validPreview = (payload: DeliveryPayload): boolean => {
  if (payload.content_type !== "application/json" || payload.filename !== "push-preview.json" || payload.content.byteLength > 1024) return false;
  const value = parseStrictContractBytes(payload.content, 1024);

  return Either.isRight(value) && Schema.is(Preview, { onExcessProperty: "error" })(value.right);
};

export interface DiscordResponse { readonly status: number; readonly body: Uint8Array; readonly retryAfter: string | null }

// Failure phase is explicit: connection/TLS failed before any POST, or submission may have begun.
export class DiscordHttp extends Context.Tag("pulse/DiscordHttp")<DiscordHttp, {
  readonly post: (destination: Redacted.Redacted<string>, timeoutSeconds: number) => Effect.Effect<DiscordResponse, { readonly phase: "connect" | "submitted" }>;
}>() {}

export class DiscordTransport extends Context.Tag("pulse/DiscordTransport")<DiscordTransport, {
  readonly send: (config: DestinationConfig, payload: DeliveryPayload) => Effect.Effect<TransportOutcome>;
  readonly retryAfter: Effect.Effect<number | null>;
}>() {}

export const makeDiscordTransport = (timeoutSeconds = 10) => Effect.gen(function* () {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 30) return yield* new AlertError({ code: "config_invalid" });
  const http = yield* DiscordHttp;
  let lastRetryAfter: number | null = null;

  return DiscordTransport.of({
    retryAfter: Effect.sync(() => lastRetryAfter),
    send: (config, payload) => Effect.gen(function* () {
      lastRetryAfter = null;

      if (config.channel !== DISCORD_CHANNEL || !endpoint(Redacted.value(config.destination)) || !validPreview(payload)) return "rejected";
      const result = yield* http.post(config.destination, timeoutSeconds).pipe(Effect.either);

      if (Either.isLeft(result)) return result.left.phase === "connect" ? "rejected" : "uncertain";
      const response = result.right;

      if (response.status === 429) {
        const hint = response.retryAfter?.trim();
        const seconds = hint ? Number(hint) : NaN;

        lastRetryAfter = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;

        return "uncertain";
      }

      if (response.status >= 400 && response.status < 500) return "rejected";

      if (response.status < 200 || response.status >= 300 || response.body.byteLength > 16384) return "uncertain";

      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));

        return Schema.is(Schema.Struct({ id: Schema.String.pipe(Schema.pattern(/^[0-9]+$(?![\s\S])/)) }))(value) ? "accepted" : "uncertain";
      } catch { return "uncertain"; }
    }),
  });
});

export const DiscordTransportLive = Layer.effect(DiscordTransport, makeDiscordTransport());
