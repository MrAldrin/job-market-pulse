import { expect, test } from "@playwright/test";
import { feedbackOrigin } from "./feedback-fixture.ts";
import { localSettingsOrigin } from "./origins.ts";

test("About explains the saved times and search mode at capture", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-01-15T08:12:00Z"));
  await page.goto("/app/#/about");
  const update = page.getByRole("region", { name: "Last update" });
  await expect(update.getByText("Times shown in Oslo time.")).toBeVisible();

  const snapshot = update.getByText("Snapshot created", { exact: true }).locator("..");
  await expect(snapshot.locator("time")).toHaveText("15 Jan 2026, 09:00");
  await expect(snapshot).toContainText("12 minutes ago");
  await expect(snapshot).toContainText("When Pulse saved this dashboard data.");

  const source = update.getByText("Source check", { exact: true }).locator("..");
  await expect(source.locator("time")).toHaveText("15 Jan 2026, 08:55");
  await expect(source).toContainText("17 minutes ago");
  await expect(source).toContainText("When Pulse last read NAV for this snapshot.");

  const mode = update.getByText("Search mode", { exact: true }).locator("..");
  await expect(mode).toContainText("Just looking");
  await expect(mode).toContainText("Recommend Exceptional jobs only.");
});

test("an older snapshot shows review history without inventing a run", async ({ page }) => {
  await page.goto("/app/#/about");
  const run = page.getByRole("region", { name: "This run’s pool" });

  await expect(run).toContainText("This snapshot has no run counts");
  await expect(run.getByRole("list")).toHaveCount(0);
  const history = page.getByRole("region", { name: "Review history" });

  await expect(history.getByRole("link", { name: "View 12 reviewed jobs in review history" })).toBeVisible();
  await expect(history.locator('[aria-hidden="true"] > span')).toHaveClass([
    "bg-signal-active-foreground", "bg-signal-neutral-foreground",
  ]);
  await expect(history.locator("dt")).toHaveText(["Reviewed", "Open", "Closed"]);
  await history.getByRole("link", { name: "View 1 closed jobs in review history" }).click();
  await expect(page.getByText("Closed jobs in review history")).toBeVisible();
  await expect(page.getByText("1 of 1 jobs")).toBeVisible();
});

const baseSteps = ["Read NAV", "Resolve locations", "Filters", "AI title screen", "AI judge", "Snapshot"];

for (const [fixture, origin] of [["legacy", ""], ["phone notifications off", localSettingsOrigin]]) {
  test(`The shortlist diagram omits optional steps for ${fixture}`, async ({ page }) => {
    await page.goto(`${origin}/app/#/about`);
    const flow = page.getByRole("region", { name: "How jobs reach the shortlist" });
    await expect(flow.getByRole("heading", { level: 3 })).toHaveText(baseSteps);
  });
}

test("About shows captured options and fit levels on a phone in light and dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const main = page.getByRole("main");
  const run = main.getByRole("region", { name: "This run’s pool" });
  const history = main.getByRole("region", { name: "Review history" });
  const flow = main.getByRole("region", { name: "How jobs reach the shortlist" });
  const fits = main.getByRole("region", { name: "Fit levels" });
  const paths = main.locator("summary").filter({ hasText: "Show feedback and repeat paths" });
  await page.goto(`${feedbackOrigin}/app/#/about`);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(main).toHaveCSS("color-scheme", colorScheme);
    await expect(main.getByRole("heading", { level: 2 })).toHaveText([
      "This run’s pool", "Review history", "How jobs reach the shortlist", "Fit levels", "Last update",
    ]);
    await expect(flow.getByRole("list", { name: "Job review steps" }).getByRole("heading")).toHaveText([
      ...baseSteps.slice(0, -1), "AI re-judge", "Snapshot", "Alerts",
    ]);
    await expect(flow.getByText("Rules", { exact: true })).toBeVisible();
    await expect(flow.getByText("AI", { exact: true })).toHaveCount(2);
    await expect(flow).toContainText("not a run log");
    await expect(fits.locator("dt")).toHaveText(["Exceptional", "Strong", "Possible", "Unknown", "Poor"]);
    await expect(fits).toContainText("Actively looking. Recommend Exceptional and Strong jobs.");
    await paths.click();
    await expect(main.getByRole("heading", { name: "Review selected levels again" })).toBeVisible();
    expect(await page.locator("html").evaluate((html) => html.scrollWidth)).toBe(320);
    await paths.click();
  }

  await expect.poll(async () => {
    const poolBox = await run.boundingBox();
    const historyBox = await history.boundingBox();

    return !!poolBox && !!historyBox && historyBox.x === poolBox.x && historyBox.width === poolBox.width
      && historyBox.y >= poolBox.y + poolBox.height;
  }).toBe(true);
  const list = run.getByRole("list", { name: "Counts by pipeline step" });

  await expect(list.getByRole("heading")).toHaveText([...baseSteps.slice(0, -1), "AI re-judge", "Snapshot"]);
  await expect(run).toContainText("3 feed changes read");
  await expect(run).toContainText("70 saved ads to filter");
  await expect(run).toContainText(/Eligible after filters\s*40/);
  await expect(run).toContainText(/Screened out by title\s*26/);
  await expect(run).toContainText(/Passed to AI judge\s*8/);
  await expect(run).toContainText("4 with a saved full review");
  await expect(run).toContainText("7 waiting · 2 failed or blocked");
  await expect(history.getByRole("link", { name: "View 12 reviewed jobs in review history" })).toBeVisible();
  await expect(history).not.toContainText("waiting");

  await run.getByRole("link", { name: /View 1 Exceptional jobs/u }).click();
  await expect(main.getByText("1 of 4 jobs")).toBeVisible();
  await page.goBack();
  await run.getByRole("link", { name: "2 recommended" }).click();
  await expect(main.getByText("2 of 2 jobs")).toBeVisible();
  await page.goBack();

  const dataNotes = main.getByText("About this data", { exact: true });
  const caveat = main.getByText("Do not infer delivery or refresh success.", { exact: false });
  await expect(caveat).toBeHidden();
  await dataNotes.click();
  await expect(caveat).toBeVisible();
  await expect(main).not.toContainText(/\bFINN\b|Fit labels are AI assessments, not verified facts/u);
});

test("About keeps run counts beside history and explains the three paths on demand", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${feedbackOrigin}/app/#/about`);
  const run = page.getByRole("region", { name: "This run’s pool" });
  const history = page.getByRole("region", { name: "Review history" });
  await expect.poll(async () => {
    const poolBox = await run.boundingBox();
    const historyBox = await history.boundingBox();

    return !!poolBox && !!historyBox && historyBox.y === poolBox.y && historyBox.x >= poolBox.x + poolBox.width;
  }).toBe(true);

  const paths = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "Show feedback and repeat paths" }) });
  const toggle = paths.locator("summary");
  await expect(paths).not.toHaveAttribute("open");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(paths).toHaveAttribute("open", "");
  await expect(paths.getByRole("heading")).toHaveText([
    "Reuse a compatible review", "Suggest a Settings change", "Review selected levels again",
  ]);
  await expect(paths.getByRole("listitem")).toHaveCount(12);
  await expect(paths).toContainText("skips a new model call");
  await expect(paths).toContainText("No approval means no change. Approval does not start a refresh.");
  await expect(paths).toContainText("Only an accepted second assessment replaces the first in the shortlist.");
  await toggle.press("Space");
  await expect(paths).not.toHaveAttribute("open");
});
