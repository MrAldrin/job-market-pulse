import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { Schema } from "effect";
import type { FeedbackState } from "../../src/lib/feedback.ts";
import { b8Origin } from "./origins.ts";

const topTitle = "Data tools developer — synthetic example";
const topId = "10000000-0000-4000-8000-000000000002";
const feedbackUrl = `${b8Origin}/app/shortlist-feedback`;

const parseFixtureChange = Schema.decodeUnknownSync(Schema.Union(
  Schema.Struct({ listing_id: Schema.Literal(topId), field: Schema.Literal("starred"), value: Schema.Boolean }),
  Schema.Struct({ listing_id: Schema.Literal(topId), field: Schema.Literal("reaction"), value: Schema.NullOr(Schema.Literal("up", "down")) }),
), { onExcessProperty: "error" });

async function fakeFeedbackForThisPage(page: Page): Promise<void> {
  const csrf = "0".repeat(64);
  let state: FeedbackState = { starred: false, reaction: null };

  // Only the existing feedback request is faked. It has no store or reload proof.
  await page.route((url) => url.href === feedbackUrl, async (route) => {
    const request = route.request();

    if (request.method() === "GET") {
      await route.fulfill({ json: { csrf_token: csrf, listing_ids: [topId], states: { [topId]: state } } });

      return;
    }

    expect(request.method()).toBe("POST");
    expect(request.headers()["x-csrf-token"]).toBe(csrf);
    const change = parseFixtureChange(request.postDataJSON());

    state = change.field === "starred" ? { ...state, starred: change.value } : { ...state, reaction: change.value };
    await route.fulfill({ json: { state } });
  });
}

async function clickAndConfirm(page: Page, control: Locator, state: FeedbackState): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url() === feedbackUrl && candidate.request().method() === "POST"),
    control.click(),
  ]);

  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ state });
}

async function openValuesWithKeyboard(page: Page): Promise<void> {
  const summary = page.locator("summary").filter({ has: page.getByText("Show values", { exact: true }) });
  const details = page.locator("details").filter({ has: summary });
  const wasOpen = await details.getAttribute("open") !== null;

  await summary.focus();
  await expect(summary).toBeFocused();
  await summary.press("Enter");

  if (wasOpen) {
    await expect(details).not.toHaveAttribute("open", "");
    await summary.press("Enter");
  }

  await expect(details).toHaveAttribute("open", "");
}

async function capture(page: Page, info: TestInfo, name: string, width: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
}

async function expectRecordedGap(chart: Locator): Promise<void> {
  const points = chart.locator("circle[data-reading-point]");
  const line = chart.locator("path[data-reading-line]");
  const straightPair = /^M(-?[\d.]+),(-?[\d.]+)L(-?[\d.]+),(-?[\d.]+)$/;

  await expect(points).toHaveCount(3);
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute("d", straightPair);
  const coords = straightPair.exec(await line.getAttribute("d") ?? "");

  if (!coords) throw new Error("Expected one straight segment");

  // Only W49 and W50 connect. W52 stays a separate mark after the gap.
  for (const i of [0, 1]) {
    const point = points.nth(i);

    expect(Number(coords[i * 2 + 1])).toBeCloseTo(Number(await point.getAttribute("cx")), 2);
    expect(Number(coords[i * 2 + 2])).toBeCloseTo(Number(await point.getAttribute("cy")), 2);
  }
}

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

for (const { name, width, height } of sizes) {
  test(`saved dashboard charts and feedback controls at ${name} width`, async ({ page, request }, info) => {
    await expect.poll(async () => {
      try {
        const response = await request.get(`${b8Origin}/healthz`);

        return response.status();
      } catch {
        return 0;
      }
    }).toBe(200);
    const document = await request.get(`${b8Origin}/app/snapshot.json`);
    const html = await request.get(`${b8Origin}/app/`);

    expect(document.ok()).toBe(true);
    expect(await document.json()).toMatchObject({ schema: "pulse.snapshot", schema_version: 2 });
    expect(html.ok()).toBe(true);
    expect(await html.text()).toContain(topTitle);

    await fakeFeedbackForThisPage(page);
    const errors: string[] = [];

    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto(`${b8Origin}/app/`);
    const main = page.getByRole("main");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const first = main.getByRole("article").first();
    const topJob = first.getByRole("link", { name: topTitle, exact: true });

    await expect(topJob).toBeVisible();
    expect((await first.boundingBox())?.y).toBeLessThan(height);
    const save = first.getByRole("button", { name: "Save", exact: true });
    const up = first.getByRole("button", { name: "Good match", exact: true });
    const down = first.getByRole("button", { name: "Not for me", exact: true });

    await expect(save).toHaveAttribute("aria-pressed", "false");
    await clickAndConfirm(page, save, { starred: true, reaction: null });
    await expect(save).toHaveAttribute("aria-pressed", "true");
    await clickAndConfirm(page, up, { starred: true, reaction: "up" });
    await expect(up).toHaveAttribute("aria-pressed", "true");
    await clickAndConfirm(page, down, { starred: true, reaction: "down" });
    await expect(up).toHaveAttribute("aria-pressed", "false");
    await expect(down).toHaveAttribute("aria-pressed", "true");
    await capture(page, info, "home", width);

    await topJob.click();
    await expect(main.getByRole("heading", { name: topTitle, exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("aria-pressed", "true");
    await capture(page, info, "job-detail", width);
    await nav.getByRole("link", { name: "Jobs", exact: true }).click();
    await expect(main.getByRole("searchbox")).toBeVisible();
    await capture(page, info, "jobs", width);

    await nav.getByRole("link", { name: "Market", exact: true }).click();
    await expect(main.getByRole("heading", { name: "Market", exact: true })).toBeVisible();
    const archivedChart = main.getByRole("figure", { name: /Archived NAV sample/ });

    await expect(archivedChart.locator("circle[data-reading-point]").first()).toBeVisible();
    await expect(main.getByText(/Not recorded.*months.*2025-06/)).toBeVisible();
    await openValuesWithKeyboard(page);
    const archive = main.getByRole("table", { name: /Archived NAV sample/ });

    await expect(archive.getByRole("row").filter({ hasText: "2025-06" })).toContainText("Missing period");
    await capture(page, info, "market-archive", width);
    await main.getByLabel("History series").selectOption({ label: "Recorded tracked stock, titles only, weekly" });
    await main.getByLabel("Count to show").selectOption({ label: "Term in all jobs: sql" });
    const recordedChart = main.getByRole("figure", { name: /Recorded tracked stock.*Term in all jobs: sql/ });

    await expectRecordedGap(recordedChart);
    await expect(main.getByRole("region", { name: "Market reading" })).toContainText("Latest saved period: week-2025-W52");
    await expect(main.getByText(/Not recorded.*weeks starting.*2025-12-15/)).toBeVisible();
    const period = recordedChart.getByLabel("Chart period");

    await period.focus();
    await expect(period).toBeFocused();
    await period.press("ArrowDown");
    await expect(recordedChart.locator("[data-reading-value]")).toHaveText("0 jobs");
    const stored = main.getByRole("table", { name: /Recorded tracked stock/ });
    const zero = stored.getByRole("row").filter({ hasText: "week-2025-W50" });

    const countName = (count: number) => name === "phone" ? `Count ${count}` : String(count);

    await expect(zero.getByRole("cell", { name: countName(0), exact: true })).toBeVisible();
    await expect(stored.getByRole("row").filter({ hasText: "week-2025-W51" })).toHaveCount(0);
    await expect(stored.getByRole("row").filter({ hasText: "week-2025-W52" }).getByRole("cell", { name: countName(4), exact: true })).toBeVisible();
    await capture(page, info, "market-recorded", width);

    await nav.getByRole("link", { name: "Salary", exact: true }).click();
    await expect(main.getByRole("heading", { name: "Salary", exact: true })).toBeVisible();
    const salaryChart = main.getByRole("figure", { name: "Monthly pay (NOK/year)", exact: true });

    await expect(main.getByRole("region", { name: "Latest salary month" })).toContainText("Hidden");
    await expect(salaryChart.locator("circle[data-reading-point]")).toHaveCount(2);
    await expect(salaryChart.locator("circle[data-salary-mean]")).toHaveCount(2);
    await expect(salaryChart.locator("path[data-salary-range]")).toHaveCount(2);
    await expect(salaryChart.locator("path[data-reading-line]")).toHaveCount(0);
    const labels = salaryChart.locator("[data-salary-month]");

    await expect(labels).toHaveText(["2025-09 n=5", "2025-10 n=0 Hidden", "2025-11 n=5", "2026-01 n=1 Hidden"]);
    const points = salaryChart.locator("circle[data-reading-point]");
    const monthX = async (index: number): Promise<number> => Number(await labels.nth(index).getAttribute("x"));

    await expect(labels.nth(1)).toBeVisible();
    expect(Number(await points.nth(0).getAttribute("cx"))).toBeCloseTo(await monthX(0), 0);
    expect(Number(await points.nth(1).getAttribute("cx"))).toBeCloseTo(await monthX(2), 0);
    expect(await monthX(1)).toBeGreaterThan(await monthX(0));
    expect(await monthX(1)).toBeLessThan(await monthX(2));
    const salaryPeriod = salaryChart.getByLabel("Chart period");
    const marker = salaryChart.locator("circle[data-reading-selected]");
    const initialX = await marker.getAttribute("cx");

    await salaryPeriod.selectOption({ label: "2025-11 · n=5" });
    await expect(marker).toBeVisible();
    await expect(marker).not.toHaveAttribute("cx", initialX ?? "");
    await expect(marker).toHaveAttribute("stroke-dasharray", "3 2");
    await expect(salaryChart.locator("[data-reading-value]")).toHaveText("Median: 720,000 NOK/year. Mean: 726,000. Observed low–high: 700,000–770,000.");

    if (name === "phone") {
      const plot = salaryChart.getByRole("region", { name: "Salary plot" });

      await expect(salaryChart.getByText("Scroll for more months.")).toBeVisible();
      await plot.focus();
      await expect(plot).toBeFocused();
      await plot.press("ArrowRight");
      await expect.poll(() => plot.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await plot.evaluate((element) => { element.scrollLeft = 0; });
    }

    await capture(page, info, "salary-selected", width);
    await salaryPeriod.focus();
    await salaryPeriod.press("ArrowUp");
    await expect(salaryPeriod).toHaveValue("1");
    await expect(marker).toHaveCount(0);
    await expect(salaryChart.locator("[data-reading-value]")).toHaveText("Hidden: fewer than 5 eligible facts.");
    await openValuesWithKeyboard(page);
    const medians = main.getByRole("table", { name: "Monthly salary statistics and counts" });

    await expect(medians.getByRole("row").filter({ hasText: "2025-11" })).toContainText("720000");
    await expect(medians.getByRole("row").filter({ hasText: "2026-01" })).toContainText("fewer than 5 eligible facts");
    await capture(page, info, "salary", width);
    await nav.getByRole("link", { name: "About", exact: true }).click();
    await expect(main.getByRole("heading", { name: "About", exact: true })).toBeVisible();
    await capture(page, info, "about", width);
    expect(errors).toEqual([]);
  });
}
