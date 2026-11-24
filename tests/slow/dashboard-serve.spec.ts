import { spoofedServeHost } from "../shared/serve-hosts.ts";
import { expect, test } from "@playwright/test";
import type { LocalSettingsDocument } from "../../src/lib/contracts/local-settings.ts";
import { feedbackPath, feedbackToken, legacyFeedbackPath } from "./feedback-fixture.ts";
import { localSettingsOrigin, serveOrigin, serveOwner, serveProxy } from "./origins.ts";

const settingsPath = "/app/local-settings";
const statusPath = "/app/run/status";
const startPath = "/app/run/start";
const suggestionsPath = "/app/local-settings/suggestions";
const host = new URL(serveOrigin).host;
const owner = { host, "x-test-serve-caller": "owner" };
const job = "10000000-0000-4000-8000-000000000001";

test("Serve owner can use the dashboard and local APIs via a real loopback hop", async ({ request }) => {
  await expect.poll(async () => {
    try { return (await request.get(serveProxy + "/healthz")).status(); } catch { return 0; }
  }).toBe(200);

  const redirect = await request.get(serveProxy + "/", { headers: owner, maxRedirects: 0 });
  expect(redirect.status()).toBe(303);
  expect(redirect.headers().location).toBe("/app/");
  const get = (path: string, headers: Record<string, string> = owner) => request.get(serveProxy + path, { headers, maxRedirects: 0 });

  for (const path of ["/app/", "/app/snapshot.json", "/app/__data.json?x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=1"]) {
    expect((await get(path)).status()).toBe(200);
  }

  const readToken = async (path: string) => {
    const response = await get(path);

    expect(response.status()).toBe(200);
    const data = await response.json();

    expect(data.csrf_token).toMatch(/^[a-f0-9]{64}$/);

    return String(data.csrf_token);
  };

  const settings = await readToken(settingsPath);
  const document: LocalSettingsDocument = await (await get(settingsPath)).json();
  const feedback = await readToken(feedbackPath);
  const run = await readToken(statusPath);

  for (const path of ["/api/v1/starred-jobs", "/api/v1/feedback-events"]) {
    expect((await get(path)).status()).toBe(401);
    expect((await get(path, { ...owner, authorization: `Bearer ${feedbackToken}` })).status()).toBe(200);
  }

  const cases = [
    [settingsPath, settings, { kind: "test_model", step: "judge", revision: document.models.revision, harness: "claude-code", provider: "anthropic", model: "sonnet", effort: "high" }, 200],
    [suggestionsPath, settings, { helper: "title_exclusion" }, 200],
    [feedbackPath, feedback, { listing_id: job, field: "starred", value: false }, 200],
    [legacyFeedbackPath, feedback, { listing_id: job, field: "starred", value: false }, 200],
    // Reach the confirmation check without ever requesting a live refresh.
    [startPath, run, { confirm: false }, 400],
  ] as const;

  for (const [path, token, data, status] of cases) {
    const headers = { ...owner, origin: serveOrigin, "x-csrf-token": token };
    const post = (changes?: Record<string, string>) => request.post(serveProxy + path, { headers: { ...headers, ...changes }, data });

    expect((await post({ origin: localSettingsOrigin })).status(), path).toBe(403);
    expect((await post({ origin: "null" })).status(), path).toBe(403);
    expect((await post({ "x-csrf-token": "" })).status(), path).toBe(403);
    expect((await post({ "x-test-serve-caller": "other" })).status(), path).toBe(403);
    expect((await post({ "x-test-serve-caller": "anonymous", "tailscale-user-login": serveOwner })).status(), path).toBe(403);
    expect((await post({ host: new URL(localSettingsOrigin).host })).status(), path).toBe(403);
    expect((await post()).status(), path).toBe(status);
  }
});

test("Serve denies other callers even with forged identity, origins or forwarded loopback IPs", async ({ request }) => {
  const paths = ["/app/", "/app/snapshot.json", "/app/__data.json?x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=1",
    settingsPath, statusPath, startPath, suggestionsPath, feedbackPath, legacyFeedbackPath, "/api/v1/starred-jobs", "/api/v1/feedback-events"];

  const spoof = { "tailscale-user-login": serveOwner, "x-forwarded-for": "127.0.0.1", "x-real-ip": "::1" };

  for (const path of paths) {
    for (const headers of [
      { ...spoof, host }, { ...spoof, host, "x-test-serve-caller": "other" },
      { ...owner, host: spoofedServeHost }, { ...owner, host: new URL(localSettingsOrigin).host },
      { ...owner, origin: `https://${spoofedServeHost}` },
      { ...owner, "x-test-serve-protocol": "http", "x-forwarded-proto": "https" },
      { ...owner, "x-test-serve-protocol": "missing" },
      { ...owner, "x-test-serve-protocol": "https, http" },
    ]) {
      expect((await request.get(serveProxy + path, { headers, maxRedirects: 0 })).status(), path).toBe(403);
    }
  }

  expect((await request.get(localSettingsOrigin + settingsPath, { headers: { host }, maxRedirects: 0 })).status()).toBe(403);
  expect((await request.get(localSettingsOrigin + feedbackPath)).status()).toBe(200);
});
