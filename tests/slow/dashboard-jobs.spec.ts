import { expect, test } from "@playwright/test";
import { feedbackOrigin } from "./feedback-fixture.ts";

test("Jobs cards show distance bands at desktop and phone widths", async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${feedbackOrigin}/app/#/jobs?fit=`);
    const main = page.getByRole("main");

    await expect(main.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();

    const bands = [
      ["≈ 10.0 km", "positive"], ["≈ 20.0 km", "caution"], ["≈ 25.0 km", "failure"], ["Distance unknown", "neutral"],
    ] as const;

    for (const [label, band] of bands) {
      await expect(main.getByText(label, { exact: true }).first()).toHaveClass(new RegExp(`bg-signal-${band}`));
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`jobs-${width}.png`), fullPage: true });
  }
});

const repeatTitle = "Datautvikler for oppdiktede tjenester";
const possibleTitle = "Prosjektmedarbeider for syntetiske rapporter";
const closedTitle = "Closed example at a fictional workshop";

for (const { width, height, device } of [
  { width: 390, height: 844, device: "phone" },
  { width: 1440, height: 960, device: "desktop" },
]) {
  test(`Jobs cards expand in place on ${device}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${feedbackOrigin}/app/`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("6 recommended jobs");
    await page.getByRole("navigation").getByRole("link", { name: "Jobs", exact: true }).click();
    const queue = main.getByRole("region", { name: "Review queue" });
    const repeatCard = queue.getByRole("listitem").filter({ hasText: repeatTitle }).first();
    const repeatSummary = repeatCard.locator("summary");
    const possibleCard = queue.getByRole("listitem").filter({ hasText: possibleTitle }).first();
    const possibleSummary = possibleCard.locator("summary");
    const why = repeatCard.getByRole("heading", { name: "Why this fit" });

    await expect(repeatSummary).toContainText("Exceptional");
    await expect(repeatSummary.getByText("Open in saved data", { exact: true })).toBeVisible();
    await expect(why).toBeHidden();
    await repeatSummary.focus();
    await repeatSummary.press("Enter");
    await expect(repeatSummary).toBeFocused();
    await expect(why).toBeVisible();
    await expect(page).toHaveURL(/#\/jobs$/u);
    const repeat = repeatCard.getByRole("region", { name: "Repeat review" });
    await expect(repeat).toContainText(/First Poor\s*→\s*Accepted Exceptional/u);
    await expect(repeat).toContainText("invented/first");
    await expect(repeat).toContainText("invented/second");
    await expect(repeatCard.getByRole("heading", { name: "Evidence from the ad" })).toBeVisible();
    await expect(repeatCard.getByRole("table", { name: "Job facts" })).toBeVisible();
    await expect(repeatCard.getByRole("link", { name: "Open the ad", exact: true })).toBeVisible();
    await expect(repeatCard.getByRole("button", { name: /save|saved/iu })).toBeVisible();

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(main).toHaveCSS("color-scheme", colorScheme);
      expect(await page.locator("html").evaluate((html) => html.scrollWidth)).toBe(width);
      await page.screenshot({ path: info.outputPath(`jobs-${device}-${colorScheme}.png`), fullPage: true, animations: "disabled" });
    }

    await repeatSummary.press("Space");
    await expect(why).toBeHidden();
    await possibleSummary.click();
    await expect(possibleCard.getByRole("heading", { name: "Check before applying" })).toBeVisible();
    await expect(possibleCard.getByText("The example does not state the team size.")).toBeVisible();
    await expect(page).toHaveURL(/#\/jobs$/u);
    await possibleCard.getByRole("link", { name: "Open job details" }).click();
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(possibleTitle);
    await main.getByRole("link", { name: "Back to jobs" }).click();
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Jobs");
    const aboutData = main.locator("summary").filter({ hasText: "About this data" });
    const coverage = main.getByRole("heading", { name: "Coverage" });
    await expect(coverage).toBeHidden();
    await aboutData.press("Enter");
    await expect(coverage).toBeVisible();
  });
}

test("Jobs fit checkboxes combine levels and keep other filters in the URL", async ({ page }) => {
  await page.goto(`${feedbackOrigin}/app/#/jobs?fit=`);
  const fits = page.getByRole("group", { name: "Filter by fit" });
  const poor = fits.getByRole("checkbox", { name: /^Poor\b/u });
  const unknown = fits.getByRole("checkbox", { name: /^Not judged\b/u });
  const count = (text: string) => page.getByText(text, { exact: true });
  const search = page.getByRole("searchbox", { name: "Search title or employer" });
  const closed = page.getByRole("checkbox", { name: "Include closed ads" });
  const sort = page.getByRole("combobox", { name: "Sort" });
  const closedSummary = page.locator("summary").filter({ hasText: closedTitle });

  await expect(count("11 of 12 jobs · All fit levels")).toBeVisible();
  await poor.check();
  await expect(count("1 of 12 jobs")).toBeVisible();
  await unknown.check();
  await expect(poor).toBeChecked();
  await expect(unknown).toBeChecked();
  await expect(count("2 of 12 jobs")).toBeVisible();
  await expect(closedSummary).toHaveCount(0);
  await closed.check();
  await expect(count("3 of 12 jobs")).toBeVisible();
  await expect(closedSummary.getByText("Closed in saved data", { exact: true })).toBeVisible();
  await closedSummary.click();
  await expect(page.getByText("No full ad text was reviewed.", { exact: true })).toBeVisible();
  await sort.selectOption("employer");
  await expect(page).toHaveURL(/sort=employer/u);
  await search.fill("Fictional Cloud Loom");
  await expect(count("1 of 12 jobs")).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue("Fictional Cloud Loom");
  await expect(sort).toHaveValue("employer");
  await expect(closed).toBeChecked();
  await expect(poor).toBeChecked();
  await expect(unknown).toBeChecked();
  await expect(closedSummary).toBeVisible();
  await unknown.uncheck();
  await expect(count("0 of 12 jobs")).toBeVisible();
  await poor.uncheck();
  await expect(count("1 of 12 jobs · All fit levels")).toBeVisible();
  const saved = page.getByRole("button", { name: "Saved", exact: true });
  await expect(saved).toHaveAttribute("aria-pressed", "false");
  await saved.click();
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/saved=1/u);
});
