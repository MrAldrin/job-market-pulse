import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { DiscordHttp, DISCORD_BODY, endpoint, makeDiscordTransport, PUSH_PREVIEW, validPreview, type DestinationConfig, type DiscordResponse } from "../../src/lib/server/alert/discord.ts";
import type { DeliveryPayload } from "../../src/lib/contracts/alert.ts";

const config: DestinationConfig = { profile_id: "owner", channel: "redacted_discord", source: "local_only", destination: Redacted.make("https://discord.example.invalid/api/webhooks/invented/token") };
const payload: DeliveryPayload = { content: new TextEncoder().encode(JSON.stringify(PUSH_PREVIEW)), content_type: "application/json", filename: "push-preview.json" };
const response = (status: number, body = '{"id":"123456789"}', retryAfter: string | null = null): DiscordResponse => ({ status, body: new TextEncoder().encode(body), retryAfter });
const run = (http: typeof DiscordHttp.Service, program: (transport: Effect.Effect.Success<ReturnType<typeof makeDiscordTransport>>) => Effect.Effect<unknown>) => Effect.runPromise(Effect.flatMap(makeDiscordTransport(), program).pipe(Effect.provide(Layer.succeed(DiscordHttp, http))));

describe("Discord retained redacted channel", () => {
  it("posts only fixed content with mentions suppressed and replaces stale wait values", () => {
    expect(JSON.parse(DISCORD_BODY)).toEqual({ content: "Job Market Pulse\nA job-market update is ready for local review.", allowed_mentions: { parse: [] } });
    expect(endpoint("https://discord.example.invalid/api/webhooks/invented/token?thread_id=123&wait=false&wait=no")).toEqual({ host: "discord.example.invalid", port: 443, target: "/api/webhooks/invented/token?thread_id=123&wait=true" });
  });
  it.each([
    [200, '{"id":"123456789"}', "accepted"], [204, "", "uncertain"], [200, '{"id":123}', "uncertain"],
    [200, '{"message":"no usable acknowledgement"}', "uncertain"], [400, "{}", "rejected"], [401, "{}", "rejected"],
    [429, "{}", "uncertain"], [302, "{}", "uncertain"], [503, "{}", "uncertain"],
  ] as const)("classifies Discord status %i without retry", async (status, body, expected) => {
    let attempts = 0;

    const outcome = await run({ post: () => Effect.sync(() => {
      attempts++;

      return response(status, body);
    }) }, (transport) => transport.send(config, payload));

    expect(outcome).toBe(expected);
    expect(attempts).toBe(1);
  });
  it("keeps connect rejection distinct from uncertainty after submission", async () => {
    for (const phase of ["connect", "submitted"] as const) {
      expect(await run({ post: () => Effect.fail({ phase }) }, (transport) => transport.send(config, payload))).toBe(phase === "connect" ? "rejected" : "uncertain");
    }
  });
  it("clears rate-limit hints on the next rejected direct attempt without retrying", async () => {
    let attempts = 0;

    const values = await run({ post: () => Effect.sync(() => { attempts++;

 return response(429, "{}", "2.5"); }) }, (transport) => Effect.gen(function* () {
      const outcome = yield* transport.send(config, payload);
      const hint = yield* transport.retryAfter;
      const rejected = yield* transport.send(config, { ...payload, content: new TextEncoder().encode('{"title":"private job"}') });

      return [outcome, hint, rejected, yield* transport.retryAfter];
    }));

    expect(values).toEqual(["uncertain", 2.5, "rejected", null]); expect(attempts).toBe(1);
  });
  it("rejects altered preview and duplicate fields before any transport call", async () => {
    for (const body of ['{"title":"private job","body":"private reason"}', '{"title":"private job","title":"Job Market Pulse","body":"A job-market update is ready for local review."}']) {
      const altered = { ...payload, content: new TextEncoder().encode(body) };

      expect(validPreview(altered)).toBe(false);
      expect(await run({ post: () => Effect.dieMessage("must not post") }, (transport) => transport.send(config, altered))).toBe("rejected");
    }
  });
  it("refuses insecure or credential-bearing configured endpoints", () => {
    for (const destination of ["http://discord.example.invalid/token", "https://user:secret@discord.example.invalid/token", "https://discord.example.invalid/token#private", "https://discord.example.invalid:99999/token"]) expect(endpoint(destination)).toBeNull();
    expect(JSON.stringify(config)).not.toContain("api/webhooks");
  });
  it("does not accept an oversized Discord acknowledgement", async () => {
    expect(await run({ post: () => Effect.succeed(response(200, JSON.stringify({ id: "123", detail: "x".repeat(16400) }))) }, (transport) => transport.send(config, payload))).toBe("uncertain");
  });
});
