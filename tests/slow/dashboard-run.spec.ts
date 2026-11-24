import { expect, test, type Page } from "@playwright/test";
import { localRunStartPath, localRunStatusPath, type LocalRunStatus } from "../../src/lib/contracts/local-run.ts";
import { stageNames } from "../../src/lib/contracts/pipeline-progress.ts";
import { hostedSettingsOrigin as hosted, localSettingsOrigin as local } from "./origins.ts";

const token = "b".repeat(64);
const started = "2026-11-19T08:00:00.000Z";
const ended = "2026-11-19T08:02:00.000Z";

const idle: LocalRunStatus = {
  status: "idle", log: [], current_stage: null, stages: stageNames.map((stage) => ({ stage, status: "pending" })),
  started_at: null, ended_at: null, retry_at: null, reset_run_id: null, error: null,
};

const review: LocalRunStatus = {
  ...idle, status: "running", current_stage: "review", started_at: started,
  stages: [
    { stage: "sync-source", status: "succeeded" },
    { stage: "resolve-locations", status: "succeeded" },
    { stage: "market", status: "failed" },
    { stage: "review", status: "running" },
    { stage: "snapshot", status: "pending" },
  ],
};

const success: LocalRunStatus = {
  ...review, status: "succeeded", current_stage: null, ended_at: ended,
  stages: stageNames.map((stage) => ({ stage, status: stage === "market" ? "skipped" : "succeeded" })),
};

// Fake only the run API. The built app still supplies page data and snapshots.
// Intercept every start, even if the client sends an incorrect method or body.
async function fakeRefresh(page: Page, admission: 202 | 409 = 202) {
  let status = idle;
  let available = true;
  let posts = 0;
  await page.route(local + localRunStatusPath, (route) => route.fulfill(
    available ? { json: { ...status, csrf_token: token } } : { status: 503 },
  ));
  await page.route("**/app/run/start*", async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    expect(request.url()).toBe(local + localRunStartPath);
    expect(request.method()).toBe("POST");
    expect(headers["origin"]).toBe(local);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-csrf-token"]).toBe(token);
    expect(request.postDataJSON()).toEqual(status.reset_run_id === null
      ? { confirm: true } : { confirm: true, reset_run_id: status.reset_run_id });
    posts += 1;

    if (admission === 202) status = review;
    await route.fulfill({ status: admission, body: admission === 409 ? "A run is already in progress" : "" });
  });

  return {
    setStatus: (next: LocalRunStatus) => { status = next; },
    setAvailable: (next: boolean) => { available = next; },
    posts: () => posts,
  };
}

const panel = (page: Page) => page.getByRole("region", { name: "Local refresh" });
const run = (page: Page) => panel(page).getByRole("button", { name: /^(Run|Start refresh)$/u });
const dialog = (page: Page) => page.getByRole("alertdialog");
const confirm = (page: Page) => dialog(page).getByRole("button", { name: "Start refresh" });

test("Run confirmation fits a dark phone view and returns focus on cancel", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await run(page).click();
  const prompt = page.getByRole("alertdialog", { name: "Start a refresh?" });
  const cancel = prompt.getByRole("button", { name: "Cancel" });
  await expect(prompt).toHaveAccessibleDescription("It reads new jobs from NAV and reviews them with your AI model.");
  await expect(prompt).toBeInViewport({ ratio: 1 });
  await expect(prompt).toHaveCSS("color-scheme", "dark");
  await expect(confirm(page)).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(run(page)).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(run(page)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(prompt).toBeHidden();
  await expect(run(page)).toBeFocused();
  expect(refresh.posts()).toBe(0);
});

test("confirmed Run shows live stages and reloads the saved snapshot on success", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await expect(run(page)).toBeEnabled();
  await run(page).click();
  await expect(confirm(page)).toBeVisible();
  expect(refresh.posts()).toBe(0);
  await confirm(page).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText("Refresh in progress.");
  await expect(panel(page).getByText("Review jobs: Running")).toBeVisible();
  await expect(panel(page).getByText("Record market data: Failed")).toBeVisible();
  const stages = panel(page).getByRole("list", { name: "Refresh stages" });
  await expect(stages.getByText("Running", { exact: true })).toHaveClass(/bg-signal-active/u);
  await expect(stages.getByText("Failed", { exact: true })).toHaveClass(/bg-signal-failure/u);
  await expect(run(page)).toBeDisabled();

  // The run survives page reload. The tab reads the same server state again.
  await page.reload();
  await expect(run(page)).toBeDisabled();
  await expect(panel(page).getByText("Review jobs: Running")).toBeVisible();
  refresh.setStatus({
    ...review,
    retry_at: "2026-11-19T08:01:00.000Z",
    stages: review.stages.map((entry) => entry.stage === "review" ? { ...entry, status: "waiting" } : entry),
  });
  await expect(stages.getByText("Waiting to retry", { exact: true })).toHaveClass(/bg-signal-caution/u);
  await expect(panel(page).getByRole("status")).toContainText("Next retry:");

  const reload = page.waitForResponse((response) => response.url().startsWith(local + "/app/__data.json?"));
  refresh.setStatus(success);
  await expect(panel(page).getByRole("status")).toContainText("Refresh complete.");
  expect((await reload).ok()).toBe(true);
  await expect(stages.getByText("Complete", { exact: true }).first()).toHaveClass(/bg-signal-positive/u);
  await expect(stages.getByText("Skipped (Market recording is disabled)", { exact: true })).toHaveClass(/bg-signal-neutral/u);
  expect(refresh.posts()).toBe(1);
  await expect(run(page)).toBeEnabled();

  // After a server restart, the persisted result has no start time. It can
  // have an earlier end time than the in-memory result for the same run.
  const extraReloads: string[] = [];
  const restored = "Last run: completed 19 Nov 2026, 09:01 (Oslo time).";
  page.on("request", (request) => {
    const url = request.url();

    if (url.startsWith(local + "/app/__data.json?")) extraReloads.push(url);
  });
  refresh.setStatus({ ...success, started_at: null, ended_at: "2026-11-19T08:01:59.900Z" });
  await expect(panel(page).getByRole("status")).toHaveText(restored);
  await page.waitForResponse(local + localRunStatusPath);
  expect(extraReloads).toEqual([]);
  await page.reload();
  await expect(panel(page).getByRole("status")).toHaveText(restored);
});

test("Run details follow the latest entries without moving a reader who scrolled up", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await panel(page).getByRole("link", { name: "Show details" }).click();
  await expect(page.getByRole("heading", { name: "Run", exact: true })).toBeVisible();
  const log = page.getByRole("log", { name: "Refresh log" });
  await expect(log.getByText("No log entries in this dashboard session.")).toBeVisible();
  await run(page).click();
  await confirm(page).click();
  await expect(panel(page).getByRole("status")).toContainText("Refresh in progress.");

  const entry = (sequence: number, message: string, level: "info" | "error" = "info"): LocalRunStatus["log"][number] => ({
    sequence, time: started, stage: "review", level, message,
  });

  const first = Array.from({ length: 20 }, (_, index) => entry(index + 1, `Judge batch ${index + 1} started (12 jobs).`));

  refresh.setStatus({ ...review, log: first });
  await expect(log.getByRole("listitem")).toHaveCount(first.length);
  await expect(log.getByRole("listitem").first().locator("time")).toHaveText("09:00");
  const distanceFromBottom = () => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect.poll(distanceFromBottom).toBeLessThan(2);
  await log.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(0);
  const batch = entry(21, "Starting re-judge.");
  refresh.setStatus({ ...review, log: [...first, batch] });
  await expect(log.getByText(batch.message)).toBeAttached();
  expect(await log.evaluate((element) => element.scrollTop)).toBe(0);

  await page.keyboard.press("End");
  await expect.poll(distanceFromBottom).toBeLessThan(2);
  const complete = entry(22, "Complete. The new data is in the dashboard.");
  refresh.setStatus({ ...success, log: [...first, batch, complete] });
  await expect(log.getByRole("listitem").last()).toContainText(complete.message);
  await expect.poll(distanceFromBottom).toBeLessThan(2);
  await expect(log.getByRole("link")).toHaveCount(0);

  await run(page).click();
  await confirm(page).click();
  await expect(panel(page).getByRole("status")).toContainText("Refresh in progress.");
  const error = "Pulse could not save the dashboard snapshot.";
  refresh.setStatus({ ...success, status: "failed", error, log: [entry(1, error, "error")] });
  await expect(log.getByRole("listitem").last()).toContainText(error);
  await expect(log.getByText("Error", { exact: true })).toBeVisible();
  expect(refresh.posts()).toBe(2);
});

test("Run keeps the snapshot and retry separate, with stages and log below on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const refresh = await fakeRefresh(page);
  refresh.setStatus({
    ...review, retry_at: ended,
    stages: review.stages.map((entry) => entry.stage === "review" ? { ...entry, status: "waiting" } : entry),
  });
  await page.goto(local + "/app/#/run");
  const status = page.getByRole("region", { name: "Refresh status" });
  const stages = page.getByRole("region", { name: "Stage status" });
  const log = page.getByRole("log", { name: "Refresh log" });
  await expect(status.getByRole("status")).toContainText("Review jobs: Waiting to retry");
  await expect(status.getByRole("status").locator("time")).toHaveText(/\b09:02$/u);
  await expect(status.locator("p").filter({ hasText: "Last saved snapshot:" }).locator("time")).toHaveText(/\b\d{2}:\d{2}$/u);
  await expect(stages.locator('[aria-current="step"]')).toContainText("Review jobs");
  await expect(log).toBeVisible();
  const [statusBox, stagesBox, logBox] = await Promise.all([status.boundingBox(), stages.boundingBox(), log.boundingBox()]);
  expect(statusBox && stagesBox && logBox && statusBox.y + statusBox.height < stagesBox.y && stagesBox.y + stagesBox.height < logBox.y).toBe(true);
});

test("Run explains how to start again when a saved refresh has no final result", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  const error = "The saved run has no final result. It may have stopped or be running outside this dashboard.";
  refresh.setStatus({
    ...idle, status: "failed", error,
    stages: idle.stages.map((entry) => entry.stage === "sync-source" ? { ...entry, status: "unknown" } : entry),
  });
  await page.goto(local + "/app/#/run");
  await expect(panel(page).getByRole("status")).toContainText(error);
  await expect(panel(page).getByText("Select Start refresh to try again.")).toBeVisible();
  await run(page).click();
  await expect(confirm(page)).toBeVisible();
  expect(refresh.posts()).toBe(0);
  await confirm(page).click();
  await expect(panel(page).getByRole("status")).toContainText("Refresh in progress.");
  expect(refresh.posts()).toBe(1);
});

test("Market shows the recording time and run, without guessing legacy stage results", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  refresh.setStatus({
    ...success, ended_at: null,
    stages: stageNames.map((stage) => ({ stage, status: "unknown" })),
  });
  await page.goto(local + "/app/#/run");
  await expect(panel(page).getByText("Record market data: Status not saved")).toBeVisible();
  await expect(panel(page).getByRole("status")).toHaveText("Last run: completed (end time unknown).");
  await page.getByRole("link", { name: "Market", exact: true }).click();
  await page.getByText("About this data", { exact: true }).click();
  await expect(page.getByText("Recording time and run ID not available.")).toBeVisible();

  const id = "c".repeat(32);
  refresh.setStatus({
    ...success, ended_at: null, last_market_recording: { captured_at: started, run_id: id },
  });
  await expect(page.getByText(`19 Nov 2026, 09:00:00 (Oslo time). Recorded by local refresh. Run ID: ${id}`)).toBeVisible();
  await page.getByRole("link", { name: "Run", exact: true }).click();
  await expect(panel(page).getByText("Record market data: Skipped (Market recording is disabled)")).toBeVisible();
});

test("Run reloads the snapshot when a refresh finishes between polls", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await expect(panel(page).getByRole("status")).toHaveText("No saved run result.");

  const nextSnapshot = () => page.waitForResponse((response) => response.url().startsWith(local + "/app/__data.json?"));
  const first = nextSnapshot();
  refresh.setStatus(success);
  expect((await first).ok()).toBe(true);
  await expect(panel(page).getByRole("status")).toContainText("Refresh complete.");

  const second = nextSnapshot();
  refresh.setStatus({ ...success, started_at: ended, ended_at: "2026-11-19T08:03:00.000Z" });
  expect((await second).ok()).toBe(true);
  expect(refresh.posts()).toBe(0);
});

test("Run reloads the snapshot once when the first poll finds a completed refresh", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  refresh.setStatus(success);
  const dataUrl = local + "/app/__data.json?";
  let reloads = 0;
  page.on("request", (request) => {
    if (request.url().startsWith(dataUrl)) reloads += 1;
  });
  const completed = page.waitForResponse((response) => response.url().startsWith(dataUrl), { timeout: 5_000 });
  await page.goto(local + "/app/");
  await expect(panel(page).getByRole("status")).toHaveText("Last run: completed 19 Nov 2026, 09:02 (Oslo time).");
  expect((await completed).ok()).toBe(true);

  // Wait for two later polls so the first unchanged response has been processed.
  for (let poll = 0; poll < 2; poll++) {
    await page.waitForResponse(local + localRunStatusPath);
  }

  expect(reloads).toBe(1);
  expect(refresh.posts()).toBe(0);
});

test("Reset and run shows the saved failure and asks before it starts a new refresh", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await run(page).click();
  await confirm(page).click();
  await expect(panel(page).getByText("Review jobs: Running")).toBeVisible();
  const error = "Pulse could not confirm the review result and did not retry it.";
  refresh.setStatus({
    ...review, status: "failed", current_stage: null, ended_at: ended, error, reset_run_id: "a".repeat(32),
    stages: review.stages.map((entry) => entry.stage === "review" ? { ...entry, status: "failed" } : entry),
  });
  await expect(panel(page).getByText("Review jobs: Failed")).toBeVisible();
  await expect(panel(page).getByRole("status")).toContainText(error);
  await page.reload();
  await expect(panel(page).getByRole("status")).toHaveText(`Last run: did not complete 19 Nov 2026, 09:02 (Oslo time). ${error}`);
  await expect(panel(page).getByText("pulse refresh --no-publish --reset", { exact: true })).toBeVisible();
  await expect(run(page)).toHaveCount(0);
  const reset = panel(page).getByRole("button", { name: "Reset and run", exact: true });
  await reset.click();
  const prompt = page.getByRole("alertdialog", { name: "Reset the stopped run and start a new refresh?" });
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toBeHidden();
  await expect(reset).toBeFocused();
  expect(refresh.posts()).toBe(1);
  await reset.click();
  await prompt.getByRole("button", { name: "Reset and run" }).click();
  await expect(panel(page).getByText("Review jobs: Running")).toBeVisible();
  expect(refresh.posts()).toBe(2);
});

test("Run refuses a confirmation if a stopped run appears while the dialog is open", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  await page.goto(local + "/app/");
  await run(page).click();
  refresh.setStatus({ ...idle, status: "failed", reset_run_id: "a".repeat(32) });
  await expect(panel(page).getByText("pulse refresh --no-publish --reset", { exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveAccessibleName("Start a refresh?");
  await confirm(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("The saved run changed. Check the run status and confirm again.");
  expect(refresh.posts()).toBe(0);
});

test("a refused readiness check leaves Run available without a reset", async ({ page }) => {
  const refresh = await fakeRefresh(page);
  refresh.setStatus({
    ...idle, status: "failed", error: "Refresh stopped during its readiness check. Pulse could not find Pi.",
  });
  await page.goto(local + "/app/");
  await expect(panel(page).getByRole("status")).toContainText("Pulse could not find Pi.");
  await expect(panel(page).getByRole("button", { name: "Reset and run" })).toHaveCount(0);
  await run(page).click();
  await confirm(page).click();
  await expect(panel(page).getByText("Review jobs: Running")).toBeVisible();
  expect(refresh.posts()).toBe(1);
});

test("Run reports a busy installation and recovers from a status outage", async ({ page }) => {
  const refresh = await fakeRefresh(page, 409);
  await page.goto(local + "/app/");
  await run(page).click();
  await confirm(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText("A run is already in progress");
  expect(refresh.posts()).toBe(1);

  refresh.setAvailable(false);
  await expect(panel(page).getByRole("status")).toContainText("Run status unavailable.");
  await expect(run(page)).toBeDisabled();
  refresh.setAvailable(true);
  await expect(run(page)).toBeEnabled();
  expect(refresh.posts()).toBe(1);
});

test("Run controls and polling are absent in snapshot-only and hosted mode", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === localRunStatusPath) calls.push(request.url());
  });

  await page.goto("/app/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Run", exact: true })).toHaveCount(0);
  await page.goto(hosted + "/app/");
  await page.getByLabel("Username", { exact: true }).fill("invented");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password-0123456789");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(hosted + "/app/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Run", exact: true })).toHaveCount(0);
  await page.goto(hosted + "/app/#/run");
  await expect(page.getByRole("log", { name: "Refresh log" })).toHaveCount(0);
  expect(calls).toEqual([]);
});
