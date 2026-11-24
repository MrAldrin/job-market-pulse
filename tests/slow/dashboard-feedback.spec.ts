import { expect, test, type Locator, type Page } from "@playwright/test";
import type { FeedbackChange, FeedbackState } from "../../src/lib/feedback.ts";
import { feedbackOrigin as origin } from "./feedback-fixture.ts";

const feedbackUrl = `${origin}/app/shortlist-feedback`;

// Each viewport writes to a different listing in the harness's temporary store.
const viewports = [
  {
    name: "desktop", width: 1280, height: 900,
    listingId: "10000000-0000-4000-8000-000000000002", title: "Data tools developer — synthetic example",
  },
  {
    name: "phone", width: 375, height: 812,
    listingId: "10000000-0000-4000-8000-000000000001", title: "Datautvikler for oppdiktede tjenester",
  },
];

async function clickAndConfirm(
  page: Page, button: Locator, listingId: string, change: FeedbackChange, state: FeedbackState,
): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url() === feedbackUrl && candidate.request().method() === "POST"),
    button.click(),
  ]);

  expect(response.request().postDataJSON()).toEqual({ listing_id: listingId, ...change });
  expect(await response.request().headerValue("origin")).toBe(origin);
  expect(await response.request().headerValue("x-csrf-token")).toMatch(/^[0-9a-f]{64}$/);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ state });
}

for (const { name, width, height, listingId, title } of viewports) {
  test(`saved star and both thumbs survive reloads at ${name} width`, async ({ page, request }) => {
    await expect.poll(async () => {
      try {
        return (await request.get(`${origin}/healthz`)).status();
      } catch {
        return 0;
      }
    }).toBe(200);

    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/app/`);
    const card = page.getByRole("article", { name: title, exact: true });
    const save = card.getByRole("button", { name: "Save", exact: true });
    const up = card.getByRole("button", { name: "Good match", exact: true });
    const down = card.getByRole("button", { name: "Not for me", exact: true });

    const expectPressed = async ({ starred, reaction }: FeedbackState) => {
      await expect(save).toHaveAttribute("aria-pressed", String(starred));
      await expect(up).toHaveAttribute("aria-pressed", String(reaction === "up"));
      await expect(down).toHaveAttribute("aria-pressed", String(reaction === "down"));
    };

    const changes = [
      { button: save, change: { field: "starred", value: true }, state: { starred: true, reaction: null } },
      { button: up, change: { field: "reaction", value: "up" }, state: { starred: true, reaction: "up" } },
      { button: down, change: { field: "reaction", value: "down" }, state: { starred: true, reaction: "down" } },
    ] satisfies { button: Locator; change: FeedbackChange; state: FeedbackState }[];

    await expectPressed({ starred: false, reaction: null });

    for (const { button, change, state } of changes) {
      await clickAndConfirm(page, button, listingId, change, state);
      const reloaded = await page.reload();

      expect(reloaded?.ok()).toBe(true);
      await expectPressed(state);
    }
  });
}
