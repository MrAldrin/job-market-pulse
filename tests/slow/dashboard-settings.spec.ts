import { expect, test } from "@playwright/test";
import { localRunStartPath, localRunStatusPath } from "../../src/lib/contracts/local-run.ts";
import { feedbackOrigin as local, feedbackToken } from "./feedback-fixture.ts";
import { b8Origin, hostedSettingsOrigin as hosted, localSettingsOrigin as editorOrigin } from "./origins.ts";

test("Settings keeps editor groups open and captured values separate at both widths", async ({ page }, testInfo) => {
  const search = page.getByRole("region", { name: "Search rules" });
  const review = page.getByRole("region", { name: "Current local settings" }).getByRole("region", { name: "Review settings" });
  const timing = page.getByRole("region", { name: "Schedule and notifications" });
  const exclusions = page.getByRole("region", { name: "Exclusions" });
  const captured = page.locator("details").filter({ has: page.locator(":scope > summary", { hasText: "Settings used for the last saved results" }) });

  const openCaptured = async () => {
    if ((await captured.getAttribute("open")) === null) await captured.locator(":scope > summary").click();
    await expect(captured).toHaveAttribute("open");
  };

  const theme = page.getByRole("combobox", { name: "Color theme" });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${editorOrigin}/app/#/settings`);
    await expect(search.getByRole("combobox", { name: "Recommend jobs" })).toBeVisible();
    await expect(search.getByRole("group", { name: "Location", exact: true })).toContainText("Saved location: 0123 → Invented village");
    await expect(search.getByRole("group", { name: "Location", exact: true }).locator("input")).toHaveCount(2);
    await expect(exclusions.getByRole("group", { name: "Excluded title terms", exact: true })).toBeVisible();
    await expect(exclusions.getByLabel("Excluded municipalities")).toBeVisible();
    const legends = await search.locator("legend").allTextContents();
    expect(legends).toEqual(["Search mode", "Location", "Review preferences", "Title screening lists"]);
    await expect(review.getByLabel("AI comparison profile text")).toBeVisible();
    await expect(timing.getByLabel("Schedule expression")).toBeVisible();
    await expect(timing.getByLabel("Secret ntfy topic")).toBeVisible();
    await openCaptured();
    await expect(captured.getByText("Search radius", { exact: true })).toBeVisible();
    await expect(captured.locator("form, input, button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(theme).toHaveValue("system");
    await expect.poll(background).toMatch(/oklch\(0\.145 0 0\)/u);
    const rules = await search.boundingBox();
    const models = await review.boundingBox();
    const schedule = await timing.boundingBox();
    const excludes = await exclusions.boundingBox();

    if (!rules || !models || !schedule || !excludes) throw new Error("Settings cards are not visible");

    expect(models.x).toBe(rules.x);
    expect(models.width).toBe(rules.width);
    expect(models.y).toBeGreaterThanOrEqual(rules.y + rules.height);
    expect(schedule.width).toBe(rules.width);

    expect(schedule.y).toBeGreaterThanOrEqual(models.y + models.height);
    expect(excludes.y).toBeGreaterThanOrEqual(schedule.y + schedule.height);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}-dark.png`), fullPage: true });
    await theme.selectOption("light");
    await expect.poll(background).toMatch(/oklch\(1 0 0\)/u);
    await page.reload();
    await expect(timing.getByLabel("Schedule expression")).toBeVisible();
    await openCaptured();
    await expect(captured.getByText("Search radius", { exact: true })).toBeVisible();
    await expect(theme).toHaveValue("light");
    await expect.poll(background).toMatch(/oklch\(1 0 0\)/u);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}-light.png`), fullPage: true });
    await theme.selectOption("system");
    await expect.poll(background).toMatch(/oklch\(0\.145 0 0\)/u);
  }
});

test("re-judge levels and model can be saved without changing the captured snapshot", async ({ page }) => {
  await page.goto(`${editorOrigin}/app/#/settings`);
  const form = page.getByRole("group", { name: "Re-judge", exact: true });
  const same = form.getByRole("checkbox", { name: "Same as the Judge model" });
  const exceptional = form.getByRole("checkbox", { name: "exceptional" });
  const poor = form.getByRole("checkbox", { name: "poor" });
  const save = form.getByRole("button", { name: "Save re-judge settings" });
  const saved = page.getByText("Saved. The captured snapshot did not change.", { exact: true });
  const model = form.getByRole("combobox", { name: "Re-judge model" });
  const snapshotPath = `${editorOrigin}/app/snapshot.json`;
  const original = await (await page.request.get(snapshotPath)).text();

  await expect(same).toBeChecked();
  await expect(exceptional).not.toBeChecked();
  await expect(model).not.toBeVisible();
  await exceptional.check();
  await poor.check();
  await same.uncheck();
  await form.getByRole("combobox", { name: "Re-judge harness" }).selectOption("pi");
  await form.getByRole("button", { name: "Refresh Pi models for re-judge" }).click();
  await expect(model.getByRole("option", { name: "invented-provider/invented-next-model" })).toBeEnabled();
  await model.selectOption("manual");
  await form.getByRole("textbox", { name: "Pi provider ID" }).fill("invented");
  await form.getByRole("textbox", { name: "Pi model ID" }).fill("manual-rejudge");
  await form.getByRole("combobox", { name: "Re-judge effort" }).selectOption("medium");
  await save.click();
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(same).not.toBeChecked();
  await expect(exceptional).toBeChecked();
  await expect(poor).toBeChecked();
  await expect(model).toHaveValue("invented/manual-rejudge");
  expect(await (await page.request.get(snapshotPath)).text()).toBe(original);

  await same.check();
  await exceptional.uncheck();
  await poor.uncheck();
  await save.click();
  await expect(saved).toBeVisible();
  const settings = await (await page.request.get(editorOrigin + "/app/local-settings")).json();
  expect(settings.rejudge).toEqual({ levels: [], same_as_judge: true });
});

test("notification settings keep the topic write-only and leave captured settings unchanged", async ({ page }) => {
  const secret = "invented-ntfy-topic-012345678";
  await page.goto(`${editorOrigin}/app/#/settings`);
  const form = page.getByRole("group", { name: "Phone notifications" });
  const enabled = form.getByRole("checkbox", { name: "Enable automatic notifications" });
  const topic = form.getByLabel("Secret ntfy topic");
  const save = form.getByRole("button", { name: "Save notifications" });
  const sendTest = form.getByRole("button", { name: "Send test" });
  const captured = page.getByText("Phone notifications at capture: Off");
  const saved = page.getByText("Saved. The captured snapshot did not change.", { exact: true });
  await page.locator("details > summary", { hasText: "Settings used for the last saved results" }).click();
  await expect(captured).toBeVisible();
  await expect(sendTest).toBeDisabled();
  await expect(topic).toHaveAttribute("type", "password");
  await enabled.check();
  await topic.fill(secret);
  await form.getByLabel("HTTPS dashboard URL").fill("https://dashboard.example.test/app/");
  await save.click();
  await expect(saved).toBeVisible();
  await expect(topic).toHaveValue("");
  await expect(sendTest).toBeEnabled();
  await page.reload();
  await expect(enabled).toBeChecked();
  await expect(topic).toHaveValue("");
  await page.locator("details > summary", { hasText: "Settings used for the last saved results" }).click();
  await expect(captured).toBeVisible();
  const response = await page.request.get(editorOrigin + "/app/local-settings");
  expect(await response.text()).not.toContain(secret);
  await enabled.uncheck();
  await save.click();
  await expect(saved).toBeVisible();
});

test("v5 displays saved re-judge history and v1 does not", async ({ page }) => {
  const path = "/app/#/jobs/10000000-0000-4000-8000-000000000001";
  const history = page.getByRole("region", { name: "Repeat review" });
  const job = page.getByRole("link", { name: "Open the ad" });

  await page.goto(local + path);
  await expect(job).toBeVisible();
  await expect(history.getByText("Re-judge model: invented/second")).toBeVisible();
  await expect(history.getByText("invented/first", { exact: false })).toBeVisible();

  await page.goto(editorOrigin + path);
  await expect(job).toBeVisible();
  await expect(history).toHaveCount(0);
});

test("the built server exposes run status only for a selected local profile", async ({ request }) => {
  const selected = await request.get(editorOrigin + localRunStatusPath);
  expect(selected.status()).toBe(200);
  expect(selected.headers()["cache-control"]).toBe("no-store");
  expect(await selected.json()).toMatchObject({ status: "idle", current_stage: null });

  for (const origin of [local, hosted]) {
    for (const path of [localRunStartPath, localRunStatusPath]) expect((await request.get(origin + path)).status()).toBe(404);
  }
});

test("older snapshots show that they do not include settings", async ({ page }) => {
  for (const path of ["/app/#/settings", `${b8Origin}/app/#/settings`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByText("This snapshot does not include settings.")).toBeVisible();
  }
});

test("hosted dashboard preserves captured settings but has no edit or feedback controls", async ({ page, request }) => {
  const main = page.getByRole("main");
  await page.goto(`${local}/app/`);
  const link = page.getByRole("navigation").getByRole("link", { name: "Settings", exact: true });
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(main.getByText("carpenter, <b>invented title</b>")).toBeVisible();
  await expect(main.getByText("NAV (excludes FINN-sourced ads)")).toBeVisible();

  await expect(main.getByText("9917 → Invented private origin", { exact: true })).toBeVisible();

  for (const value of ["9918", "60, 10.5", "invented lookup"]) {
    await expect(main.getByText(value, { exact: true })).toHaveCount(0);
  }

  await expect(main.getByText("Works with <b>invented systems</b>.", { exact: false })).toBeVisible();
  await expect(main.getByText("invented systems", { exact: true })).toHaveCount(0);
  await expect(main.getByText("claude-code · anthropic / invented-model · high · Batch size 4")).toBeVisible();
  await expect(main.getByText("Every 2 weeks on Friday at 09:15 (Europe/Oslo)")).toBeVisible();
  await expect(main.getByText("Saved anchor: 2026-11-13")).toBeVisible();
  await expect(main.getByText("This snapshot does not show whether a host timer is enabled.")).toBeVisible();
  await expect(main.getByText("Re-judge levels: exceptional, poor.")).toBeVisible();
  await expect(main.locator("form, input, button")).toHaveCount(0);
  const captured = await main.innerText();

  const bearer = { Authorization: `Bearer ${feedbackToken}` };
  const privateValues = /Invented private origin|9917|9918|Invented comparison profile|personal_inputs/u;

  for (const path of ["/app/", "/app/snapshot.json"]) {
    const denied = await request.get(hosted + path, { headers: bearer, maxRedirects: 0 });
    expect(denied.status()).toBe(303);
    expect(await denied.text()).not.toMatch(privateValues);
  }

  const data = await request.get(hosted + "/app/__data.json?x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=1", {
    headers: bearer, maxRedirects: 0,
  });

  expect(await data.json()).toEqual({ type: "redirect", status: 303, location: "/login?next=%2Fapp%2F" });

  for (const path of ["/healthz", "/login"]) {
    const response = await request.get(hosted + path);
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toMatch(privateValues);
  }

  const feedbackRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (new URL(outgoing.url()).pathname.endsWith("/shortlist-feedback")) feedbackRequests.push(outgoing.url());
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${hosted}/app/`);
  await page.getByLabel("Username", { exact: true }).fill("invented");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password-0123456789");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${hosted}/app/`);
  await page.goto(`${hosted}/app/#/settings`);
  await expect(main.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect(await main.innerText()).toBe(captured);
  await expect(main.locator("form, input, button")).toHaveCount(0);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page).toHaveURL(`${hosted}/app/#/jobs`);
  await expect(main.getByRole("group", { name: "Your feedback" })).toHaveCount(0);
  expect(feedbackRequests).toEqual([]);

  for (const path of ["/app/shortlist-feedback", "/shortlist-feedback", "/api/v1/starred-jobs", "/api/v1/feedback-events"]) {
    expect((await page.request.get(hosted + path, { maxRedirects: 0 })).status()).toBe(404);
    expect((await page.request.post(hosted + path, { headers: { origin: hosted }, maxRedirects: 0 })).status()).toBe(404);
    const response = await request.get(hosted + path, { headers: bearer, maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toMatch(privateValues);
  }

  for (const origin of [local, hosted]) {
    const path = `${origin}/app/local-settings`;
    expect((await page.request.get(path, { maxRedirects: 0 })).status()).toBe(404);
    const change = { kind: "narrative", revision: "a".repeat(64), values: "An invented edit." };
    expect((await page.request.post(path, { data: change, headers: { origin }, maxRedirects: 0 })).status()).toBe(404);
  }
});

test("local settings save one step and add and remove excluded terms without changing the snapshot", async ({ context, page }) => {
  const path = `${editorOrigin}/app/#/settings`;
  const stale = await context.newPage();
  await page.goto(path);
  await stale.goto(path);
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  const oldModel = stale.getByRole("combobox", { name: "Model", exact: true });
  const harness = page.getByRole("combobox", { name: "Harness", exact: true });
  const effort = page.getByRole("combobox", { name: "Effort", exact: true });
  const saveStatus = page.getByText("Saved. The captured snapshot did not change.", { exact: true });
  await expect(model).toHaveValue("openai/synthetic-pi-model");
  await page.locator("details > summary", { hasText: "Settings used for the last saved results" }).click();
  await expect(page.getByText("This snapshot does not include home location or the comparison profile.")).toBeVisible();
  await expect(oldModel).toHaveValue("openai/synthetic-pi-model");
  const snapshotPath = `${editorOrigin}/app/snapshot.json`;
  const snapshot = await (await page.request.get(snapshotPath)).text();

  await page.getByRole("button", { name: "Refresh Pi models" }).click();
  await expect(page.getByText("Pi model list refreshed.")).toBeVisible();
  await expect(model.getByRole("option", { name: /without-reasoning/ })).toBeDisabled();
  await model.selectOption("invented-provider/invented-next-model");
  await expect(effort.getByRole("option", { name: "high", exact: true })).toHaveCount(0);
  await effort.selectOption("xhigh");
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(saveStatus).toBeVisible();

  await stale.getByRole("combobox", { name: "Harness", exact: true }).selectOption("claude-code");
  await oldModel.selectOption("anthropic/haiku");
  await stale.getByRole("button", { name: "Save model" }).click();
  await expect(stale.getByText("Settings changed. Reload before saving again.")).toBeVisible();
  await stale.getByRole("button", { name: "Reload current settings" }).click();
  await expect(oldModel).toHaveValue("invented-provider/invented-next-model");
  await stale.close();
  await page.reload();
  await expect(model).toHaveValue("invented-provider/invented-next-model");
  await expect(effort).toHaveValue("xhigh");
  await expect(model.getByRole("option", { name: /without-reasoning/ })).toBeDisabled();

  // The editor server's PATH contains only the fake harnesses.
  await harness.selectOption("claude-code");
  await model.selectOption("anthropic/sonnet");
  await page.getByRole("button", { name: "Test this model" }).click();
  await expect(page.getByText("The harness did not return a valid result for this model.", { exact: false })).toBeVisible();
  await effort.selectOption("high");
  await page.getByRole("button", { name: "Test this model" }).click();
  await expect(page.getByText("Model test passed. Settings were not saved.")).toBeVisible();
  const beforeSave = await (await page.request.get(`${editorOrigin}/app/local-settings`)).json();
  expect(beforeSave.models.steps.judge).toMatchObject({ harness: "pi", model: "invented-next-model", effort: "xhigh" });
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(saveStatus).toBeVisible();

  const afterSave = await (await page.request.get(`${editorOrigin}/app/local-settings`)).json();
  expect(afterSave.models.steps.rejudge).toEqual(beforeSave.models.steps.rejudge);
  await page.getByRole("button", { name: "Remove old invented title", exact: true }).click();
  await page.getByRole("textbox", { name: "New title term" }).fill("new invented title");
  await page.getByRole("button", { name: "Add term" }).click();
  await expect(page.getByRole("button", { name: "Save title terms" })).toBeEnabled();
  await page.getByRole("button", { name: "Save title terms" }).click();
  await expect(page.getByRole("button", { name: "Save title terms" })).toBeDisabled();
  await expect(saveStatus).toBeVisible();
  await page.reload();
  await expect(harness).toHaveValue("claude-code");
  await expect(model).toHaveValue("anthropic/sonnet");
  await expect(effort).toHaveValue("high");
  await expect(page.getByText("new invented title", { exact: true })).toBeVisible();
  await expect(page.getByText("old invented title", { exact: true })).toHaveCount(0);
  await page.locator("details > summary", { hasText: "Settings used for the last saved results" }).click();
  await expect(page.getByText("carpenter, <b>invented title</b>")).toBeVisible();
  expect(await (await page.request.get(snapshotPath)).text()).toBe(snapshot);
});

test("the local editor saves search mode, review inputs and schedule but leaves the snapshot unchanged", async ({ page }) => {
  const snapshotUrl = `${editorOrigin}/app/snapshot.json`;
  const snapshot = await (await page.request.get(snapshotUrl)).text();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${editorOrigin}/app/#/settings`);
  await expect(page.getByText(/Jobs that still qualify keep their saved reviews/)).toBeVisible();

  const save = async (name: string) => {
    const result = page.waitForResponse((response) => response.url() === `${editorOrigin}/app/local-settings` && response.request().method() === "POST");
    await page.getByRole("button", { name, exact: true }).click();
    expect((await result).status()).toBe(200);
    await expect(page.getByText("Saved. The captured snapshot did not change.", { exact: true })).toBeVisible();
  };

  const mode = page.getByRole("combobox", { name: "Recommend jobs" });
  await expect(mode).toHaveValue("passive");
  await expect(mode).toHaveAccessibleDescription(/Recommend Exceptional jobs only.*Recommend Exceptional and Strong jobs/);
  await mode.selectOption({ label: "Actively looking" });
  await save("Save search mode");

  const location = { "Search radius (km)": "33", "Home postcode": "0123" };
  const exclusions = { "Excluded municipalities": "Invented south", "Allowed occupation categories": "Construction", "Excluded employers": "Invented employer" };

  const titles = {
    "Academic titles": "invented academic\nengineer*", "Business development titles": "invented planner",
    "Sales titles": "invented seller", "Technical words": "utvikler*",
  };

  const schedule = { "Schedule expression": "every 2 weeks friday 16:00", "Interval start date (YYYY-MM-DD)": "2026-11-13" };
  const narrative = "# Invented profile\nEnjoys building wooden boats.\n";

  await expect(page.getByLabel("Search radius (km)")).toHaveValue("30");
  await page.getByLabel("Search radius (km)").fill("0");
  await page.getByRole("button", { name: "Save location", exact: true }).click();
  await expect(page.getByText(/radius greater than 0/)).toBeVisible();

  for (const [label, value] of Object.entries(location)) await page.getByLabel(label, { exact: true }).fill(value);
  await save("Save location");
  await expect(page.getByText("Saved location: 0123 → Invented village")).toBeVisible();

  for (const [label, value] of Object.entries(exclusions)) await page.getByLabel(label, { exact: true }).fill(value);
  await save("Save remaining filters");
  await page.getByLabel("Preferred terms").fill("woodwork\nboat building");
  await save("Save preferred terms");

  await expect(page.getByLabel("Academic titles", { exact: true })).toHaveValue("old academic*");
  const advanced = page.getByRole("group", { name: "Title screening lists" }).getByText("Advanced (read-only)", { exact: true });
  await advanced.click();
  await expect(page.getByText(String.raw`\bengineer*\b`, { exact: true })).toBeVisible();
  await page.getByLabel("Technical words").fill("engineer.*");
  await page.getByRole("button", { name: "Save title screening lists" }).click();
  await expect(page.getByText(/Use one word or phrase per line/)).toBeVisible();

  for (const [label, value] of Object.entries(titles)) await page.getByLabel(label, { exact: true }).fill(value);
  await save("Save title screening lists");
  const settingsUrl = `${editorOrigin}/app/local-settings`;
  const savedScreen = (await (await page.request.get(settingsUrl)).json()).screen;
  expect(savedScreen.advanced.academic).toEqual([String.raw`\bengineer*\b`]);
  expect(savedScreen.values.academic).toEqual(["invented academic", "engineer*"]);
  const initialSchedule = (await (await page.request.get(settingsUrl)).json()).schedule;
  await expect(page.getByLabel("Schedule expression")).toHaveValue(" weekly ");
  await save("Save schedule");
  // The revision is the hash of profile.toml, including its comments.
  expect((await (await page.request.get(settingsUrl)).json()).schedule).toEqual(initialSchedule);
  await page.getByLabel("Schedule expression").fill(schedule["Schedule expression"]);
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Enter a start date for the interval.")).toBeVisible();
  await page.getByLabel("Interval start date (YYYY-MM-DD)").fill(schedule["Interval start date (YYYY-MM-DD)"]);
  await save("Save schedule");
  await mode.selectOption({ label: "Just looking" });
  await save("Save search mode");
  await mode.selectOption({ label: "Actively looking" });
  await save("Save search mode");
  await page.getByLabel("AI comparison profile text").fill(narrative);
  await save("Save comparison profile");

  await page.reload();
  await expect(mode).toHaveValue("active");
  const fields = { ...location, ...exclusions, ...titles, ...schedule, "Preferred terms": "woodwork\nboat building", "AI comparison profile text": narrative };

  for (const [label, value] of Object.entries(fields)) await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  expect(await (await page.request.get(snapshotUrl)).text()).toBe(snapshot);
});
