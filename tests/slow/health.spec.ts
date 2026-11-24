import { expect, test } from "@playwright/test";

test("local saved-data pages load without login even when the adapter rewrites the origin", async ({ request, page }) => {
  const response = await request.get("/healthz");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });

  const snapshot = await request.get("/app/snapshot.json");
  const snapshotHead = await request.head("/app/snapshot.json");

  expect(snapshot.status()).toBe(200);
  expect(snapshot.headers()["cache-control"]).toBe("no-store");
  expect(await snapshot.json()).toMatchObject({ schema: "pulse.snapshot", schema_version: 1 });
  expect(snapshotHead.status()).toBe(200);
  expect(snapshotHead.headers()["content-length"]).toBe(snapshot.headers()["content-length"]);
  expect(await snapshotHead.body()).toHaveLength(0);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Job Market Pulse", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data tools developer — synthetic example", exact: true })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "Jobs", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search title or employer" }).fill("Data tools developer");
  await page.getByText("Data tools developer — synthetic example", { exact: true }).click();
  await page.getByRole("link", { name: "Open job details", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data tools developer — synthetic example", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Data tools developer — synthetic example · Job Market Pulse");
  await page.getByRole("link", { name: /Back/ }).click();
  await expect(page.getByRole("searchbox", { name: "Search title or employer" })).toHaveValue("Data tools developer");
  await page.getByRole("navigation").getByRole("link", { name: "About", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});

test("a browser arriving from a real non-loopback test socket gets login, not a forwarded-header bypass", async ({ page }) => {
  test.skip(process.env.PULSE_TEST_NONLOOPBACK !== "1", "Needs the approved synthetic address in the isolated route-free namespace");
  await page.setExtraHTTPHeaders({ "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" });
  await page.goto("http://127.0.0.1:4175/app/");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
