import { expect, test } from "@playwright/test";
import type { FeedbackState } from "../../src/lib/feedback.ts";
import {
  disabledFeedbackOrigin, dotTarget, feedbackAlias, feedbackHost, feedbackOrigin, feedbackPath, feedbackToken,
  legacyFeedbackPath, literalFeedbackStatus,
} from "./feedback-fixture.ts";

const FEEDBACK_EVENTS_PATH = "/api/v1/feedback-events";
const token = { Authorization: `Bearer ${feedbackToken}` };
const denied = "not-allowed.invalid";
const crossOrigin = "http://wrong-origin.invalid";

async function status(...args: Parameters<typeof literalFeedbackStatus>): Promise<number> {
  const [target, host = feedbackHost, method = "GET", headers, , capability = "enabled"] = args;
  const code = await literalFeedbackStatus(...args);

  if (target !== "/healthz") console.log(JSON.stringify({ method, target, host, capability, status: code,
    bearer: headers?.Authorization !== undefined, origin: headers?.Origin ?? null, csrf: headers?.["X-CSRF-Token"] !== undefined,
  }));

  return code;
}

async function waitForFeedback(): Promise<void> {
  await expect.poll(async () => {
    try { return await status("/healthz"); } catch { return 0; }
  }).toBe(200);
}

test("built bearer reads keep the Host, bearer and query gates on literal dot targets", async () => {
  await waitForFeedback();
  // Initialize only the invented phone store through its browser read path.
  expect(await status(feedbackPath)).toBe(200);

  for (const path of ["/api/v1/starred-jobs", FEEDBACK_EVENTS_PATH]) {
    const dotted = dotTarget(path);

    expect(await status(path, denied, "GET", token)).toBe(403);
    expect(await status(dotted, denied, "GET", token)).toBe(403);

    for (const host of [feedbackHost, feedbackAlias]) {
      expect(await status(path, host, "GET", token)).toBe(200);
      expect(await status(dotted, host, "GET", token)).toBe(200);
      expect(await status(dotted, host)).toBe(401);
      expect(await status(dotted, host, "GET", { Authorization: `${token.Authorization}x` })).toBe(401);
      expect(await status(dotted + "?profile_id=other", host, "GET", token)).toBe(400);
    }

    expect(await status(path + "?", feedbackHost, "GET", token)).toBe(400);
    expect(await status(path + "?", feedbackAlias, "GET", token)).toBe(200);
    expect(await status(path, feedbackHost, "HEAD", token)).toBe(405);
    // The form-CSRF check can run before the application's method gate.
    expect(await status(path, feedbackHost, "POST", token)).toBe(403);
    expect(await status(path, feedbackHost, "POST", { ...token, Origin: crossOrigin })).toBe(403);
    expect(await status(path, feedbackHost, "POST", { ...token, Origin: feedbackOrigin })).toBe(405);
  }

  const host = new URL(disabledFeedbackOrigin).host;

  const disabled = (path: string, method: "GET" | "POST", headers: Readonly<Record<string, string>> = token) =>
    status(path, host, method, headers, undefined, "disabled");

  await expect.poll(async () => {
    try { return await disabled("/healthz", "GET", {}); } catch { return 0; }
  }).toBe(200);
  expect(await disabled(FEEDBACK_EVENTS_PATH, "GET")).toBe(404);
  expect(await disabled(FEEDBACK_EVENTS_PATH, "POST")).toBe(403);
  expect(await disabled(FEEDBACK_EVENTS_PATH, "POST", { ...token, Origin: crossOrigin })).toBe(403);
  expect(await disabled(FEEDBACK_EVENTS_PATH, "POST", { ...token, Origin: disabledFeedbackOrigin })).toBe(404);
});

test("built legacy feedback alias retains the Host and nonempty query gates", async () => {
  await waitForFeedback();
  const dotted = dotTarget(legacyFeedbackPath);

  expect(await status(legacyFeedbackPath, denied)).toBe(403);
  expect(await status(dotted, denied)).toBe(403);
  expect(await status(legacyFeedbackPath + "?", denied)).toBe(403);

  for (const host of [feedbackHost, feedbackAlias]) {
    expect(await status(legacyFeedbackPath, host)).toBe(200);
    expect(await status(dotted, host)).toBe(200);
    expect(await status(legacyFeedbackPath + "?", host)).toBe(host === feedbackHost ? 404 : 200);
    expect(await status(legacyFeedbackPath + "?profile_id=other", host)).toBe(404);
    expect(await status(dotted + "?profile_id=other", host)).toBe(404);
  }
});

test("built feedback dot targets reject unauthorized JSON POSTs without changing saved state", async ({ request }) => {
  await waitForFeedback();
  const url = feedbackOrigin + feedbackPath;
  const initial = await request.get(url);

  expect(initial.status()).toBe(200);
  const before: { csrf_token: string; states: Record<string, FeedbackState> } = await initial.json();
  const listingId = "10000000-0000-4000-8000-000000000001";
  const state = before.states[listingId];

  if (!state) throw new Error("Synthetic listing state is missing");
  expect([true, false]).toContain(state.starred);
  expect(before.csrf_token).toMatch(/^[0-9a-f]{64}$/);
  const body = JSON.stringify({ listing_id: listingId, field: "starred", value: !state.starred });
  const dotted = dotTarget(feedbackPath);
  const headers = { Origin: feedbackOrigin, "X-CSRF-Token": before.csrf_token };

  expect(await status(dotted, denied)).toBe(403);
  expect(await status(dotted, denied, "POST", { ...headers, Origin: `http://${denied}` }, body)).toBe(403);
  expect(await status(feedbackPath + "?")).toBe(404);
  expect(await status(feedbackPath + "?", feedbackAlias)).toBe(200);

  for (const [host, origin] of [[feedbackHost, feedbackOrigin], [feedbackAlias, `http://${feedbackAlias}`]] as const) {
    const accepted = { ...headers, Origin: origin };

    expect(await status(dotted, host)).toBe(200);
    expect(await status(dotted + "?profile_id=other", host)).toBe(404);
    expect(await status(dotted, host, "POST", { ...accepted, Origin: "null" }, body)).toBe(403);
    expect(await status(dotted, host, "POST", { ...accepted, Origin: "http://wrong-origin.invalid" }, body)).toBe(403);
    expect(await status(dotted, host, "POST", { Origin: origin }, body)).toBe(403);
    expect(await status(dotted, host, "POST", { ...accepted, "X-CSRF-Token": "not-the-token" }, body)).toBe(403);
    expect(await status(dotted + "?profile_id=other", host, "POST", accepted, body)).toBe(400);
  }

  const final = await request.get(url);

  expect(final.status()).toBe(200);
  expect(await final.json()).toEqual(before);
});
