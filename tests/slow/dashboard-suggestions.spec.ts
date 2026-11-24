import { expect, test } from "@playwright/test";
import type { LocalSettingsDocument } from "../../src/lib/contracts/local-settings.ts";
import { hostedSettingsOrigin as hosted, localSettingsOrigin as local } from "./origins.ts";

const api = `${local}/app/local-settings`;
const settingsSuggestionsPath = "/app/local-settings/suggestions";
const profileEdit = "Prefers building tools over direct sales.";

test("local AI helpers preview, reject and approve only the displayed changes", async ({ page, request }) => {
  const read = async (): Promise<LocalSettingsDocument> => (await request.get(api)).json();
  const settings = await read();
  const snapshotUrl = `${local}/app/snapshot.json`;
  const snapshot = await (await request.get(snapshotUrl)).text();
  const payload = { helper: "title_exclusion" };
  expect((await request.post(hosted + settingsSuggestionsPath, { data: payload })).status()).toBe(404);
  expect((await request.post(local + settingsSuggestionsPath, { data: payload, headers: { origin: local } })).status()).toBe(403);
  expect((await request.get(local + settingsSuggestionsPath)).status()).toBe(405);
  expect((await request.post(local + settingsSuggestionsPath, { data: { ...payload, revision: "invented" },
    headers: { origin: local, "x-csrf-token": settings.csrf_token } })).status()).toBe(400);

  await page.goto(`${local}/app/#/settings`);
  const helper = page.getByRole("group", { name: "AI settings suggestions" });
  const status = helper.getByRole("status");
  const profile = helper.getByRole("button", { name: "Suggest profile edit" });
  const title = helper.getByRole("button", { name: "Suggest title exclusion" });
  const approve = helper.getByRole("button", { name: "Approve suggestion" });
  const reject = helper.getByRole("button", { name: "Reject suggestion" });

  for (const [name, description] of [
    ["Suggest profile edit", /saved profile text.*title, job ID and reaction.*liked.*disliked jobs/],
    ["Suggest title exclusion", /24 titles from fully reviewed poor-fit jobs/],
    ["Suggest employer exclusion", /employer names.*two supporting job titles/],
    ["Suggest preferred term", /liked job titles.*saved preferred terms/],
    ["Check exclusions against liked jobs", /current exclusions.*list name.*one liked job title/],
  ] as const) {
    await expect(helper.getByRole("button", { name })).toHaveAccessibleDescription(description);
  }

  await profile.click();
  await expect(status).toHaveText("No supported suggestion. Nothing was saved.");
  await expect(approve).toHaveCount(0);

  const feedback = `${local}/app/shortlist-feedback`;
  const response = await request.get(feedback);
  expect(response.ok()).toBe(true);
  const { csrf_token } = await response.json();
  const headers = { origin: local, "x-csrf-token": csrf_token };

  for (const [suffix, value] of [["001", "up"], ["010", "down"]]) {
    const write = await request.post(feedback, { headers, data: { listing_id: `10000000-0000-4000-8000-000000000${suffix}`, field: "reaction", value } });
    expect(write.ok()).toBe(true);
  }

  await profile.click();
  await expect(helper.getByText(/Input: 1 liked and 1 disliked/)).toBeVisible();
  await expect(helper.getByText(/Profile text diff/)).toBeVisible();
  await expect(helper.getByText(profileEdit, { exact: false })).toBeVisible();
  await expect(helper.getByRole("list", { name: "Evidence" }).getByRole("listitem")).toHaveCount(2);
  expect((await read()).narrative).toEqual(settings.narrative);
  await reject.click();
  await expect(status).toHaveText("Rejected. Nothing was saved.");
  expect((await read()).narrative).toEqual(settings.narrative);
  await profile.click();
  await approve.click();
  await expect(status).toHaveText("Approved and saved.");
  const approvedText = `${settings.narrative?.text}\n${profileEdit}\n`;
  expect((await read()).narrative?.text).toBe(approvedText);

  await profile.click();
  const diff = helper.locator("pre");
  await expect(diff).toHaveCount(2);
  await expect(diff.nth(0)).toContainText("direct sales.\\n");
  await expect(diff.nth(1)).toContainText("building\\u{200B} tools over direct sales.\\r\\n");
  await reject.click();
  expect((await read()).narrative?.text).toBe(approvedText);

  await title.click();
  await expect(helper.getByText("Sales role", { exact: true })).toBeVisible();
  await expect(helper.getByText("Nothing is saved without approval.", { exact: true })).toBeVisible();
  await expect(helper.getByRole("list", { name: "Evidence" }).getByRole("listitem")).toHaveCount(2);
  expect((await read()).filters).toEqual(settings.filters);
  await reject.click();
  expect((await read()).filters).toEqual(settings.filters);

  // A concurrent edit is not overwritten by approving a proposal for the old file.
  await title.click();
  await expect(approve).toBeEnabled();
  const terms = [...settings.filters.excluded_title_terms, "invented concurrent term"];
  expect((await request.post(api, { headers: { origin: local, "x-csrf-token": settings.csrf_token },
    data: { kind: "excluded_title_terms", revision: settings.filters.revision, values: terms } })).ok()).toBe(true);
  await approve.click();
  await expect(page.getByText("Settings changed. Reload before saving again.")).toBeVisible();
  expect((await read()).filters.excluded_title_terms).toEqual(terms);
  await page.getByRole("button", { name: "Reload current settings" }).click();
  await title.click();
  await approve.click();
  await expect(status).toHaveText("Approved and saved.");
  expect((await read()).filters.excluded_title_terms).toEqual([...terms, "Sales role"]);
  await expect(page.getByRole("button", { name: "Remove Sales role", exact: true })).toBeVisible();
  const beforePart2 = await read();
  await helper.getByRole("button", { name: "Suggest employer exclusion" }).click();
  await expect(helper.getByText("Fictional Quiet Beacon 10", { exact: true })).toBeVisible();
  expect((await read()).filters).toEqual(beforePart2.filters);
  await reject.click();
  expect((await read()).filters).toEqual(beforePart2.filters);
  await helper.getByRole("button", { name: "Suggest employer exclusion" }).click();
  await approve.click();
  await expect(status).toHaveText("Approved and saved.");
  const afterEmployer = (await read()).filters;
  expect(afterEmployer.excluded_employers).toEqual([...beforePart2.filters.excluded_employers, "Fictional Quiet Beacon 10"]);
  expect(afterEmployer.location).toEqual(beforePart2.filters.location);
  expect(afterEmployer.excluded_municipalities).toEqual(beforePart2.filters.excluded_municipalities);
  expect(afterEmployer.allowed_occupation_categories).toEqual(beforePart2.filters.allowed_occupation_categories);
  expect(afterEmployer.excluded_title_terms).toEqual(beforePart2.filters.excluded_title_terms);

  await helper.getByRole("button", { name: "Suggest preferred term" }).click();
  await expect(helper.getByText("Datautvikler", { exact: true })).toBeVisible();
  expect((await read()).judge).toEqual(beforePart2.judge);
  await approve.click();
  await expect(status).toHaveText("Approved and saved.");
  expect((await read()).judge?.preferred_terms).toEqual([...(beforePart2.judge?.preferred_terms ?? []), "Datautvikler"]);

  const remove = helper.getByRole("button", { name: "Check exclusions against liked jobs" });
  await remove.click();
  await expect(status).toHaveText("No supported suggestion. Nothing was saved.");
  await expect(helper.getByText(/cannot show which rules have never matched/)).toBeVisible();
  await page.getByRole("textbox", { name: "New title term" }).fill("Datautvikler");
  await page.getByRole("button", { name: "Add term", exact: true }).click();
  await page.getByRole("button", { name: "Save title terms" }).click();
  await expect.poll(async () => (await read()).filters.excluded_title_terms).toContain("Datautvikler");
  await remove.click();
  await expect(helper.getByText(/does not show whether the rule blocked/)).toBeVisible();
  await approve.click();
  await expect(status).toHaveText("Approved and saved.");
  expect((await read()).filters.excluded_title_terms).toEqual(afterEmployer.excluded_title_terms);
  expect(await (await request.get(snapshotUrl)).text()).toBe(snapshot);
});
