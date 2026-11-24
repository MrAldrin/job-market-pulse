import { expect, test, type Page } from "@playwright/test";

const hosted = "http://localhost:4174";

async function submitLogin(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/login"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);

  expect(await response.request().headerValue("origin")).toBe(hosted);

  return response;
}

test.describe("hosted credential boundary", () => {
  test.describe.configure({ mode: "serial" });

  test("generated assets are public but HTML/data need a session, including from loopback", async ({ page, request }) => {
    await expect.poll(async () => (await request.get(`${hosted}/healthz`)).status()).toBe(200);
    await page.goto("/app/");
    const asset = await page.locator('link[rel="modulepreload"]').first().getAttribute("href");

    expect(asset).toBeTruthy();
    const assetUrl = new URL(asset ?? "", hosted);

    expect((await request.get(assetUrl.href, { maxRedirects: 0 })).status()).toBe(200);

    for (const path of ["/app/", "/app/snapshot.json", "/digests.sqlite", "/upload"]) {
      const denied = await request.get(hosted + path, { maxRedirects: 0, headers: { "x-real-ip": "127.0.0.1", "x-forwarded-for": "::1" } });

      expect(denied.status(), path).toBe(303);
      expect(denied.headers().location).toContain("/login?next=");
    }

    // Kit serializes a data-request redirect for its own client router.
    const data = await request.get(hosted + "/app/__data.json?x-sveltekit-invalidated=01&x-sveltekit-trailing-slash=1&view=recent", { maxRedirects: 0 });

    expect(data.headers()["cache-control"]).toContain("no-store");
    expect(await data.json()).toEqual({ type: "redirect", status: 303, location: "/login?next=%2Fapp%2F%3Fview%3Drecent" });

    const loginHead = await request.head(hosted + "/login");
    const loginPage = await page.goto(hosted + "/app/");

    expect(loginHead.status()).toBe(200);
    expect(loginHead.headers()["referrer-policy"]).toBe("same-origin");
    expect(await loginPage?.headerValue("referrer-policy")).toBe("same-origin");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("invented");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");

    const failed = await submitLogin(page);

    expect(failed.status()).toBe(401);
    expect(await failed.headerValue("referrer-policy")).toBe("same-origin");
    expect(await failed.headerValue("set-cookie")).toBeNull();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("invented");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-password-0123456789");

    const signedIn = await submitLogin(page);

    expect(signedIn.status()).toBe(303);
    expect(await signedIn.headerValue("referrer-policy")).toBe("no-referrer");
    await expect(page.getByRole("link", { name: "Job Market Pulse", exact: true })).toBeVisible();
    const cookie = (await page.context().cookies()).find((entry) => entry.name === "jmp_session");

    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect((await page.request.get(hosted + "/app/snapshot.json", { maxRedirects: 0 })).status()).toBe(404);
    expect((await page.request.get(hosted + "/digests.sqlite", { maxRedirects: 0 })).status()).toBe(404);

    // These form submissions reach the built Kit app, not the auth service alone.
    for (const origin of [undefined, "https://outside.example", "null"]) {
      const headers: Record<string, string> = origin === undefined ? {} : { origin };

      const login = await page.request.post(hosted + "/login", {
        form: { username: "invented", password: "synthetic-password-0123456789" }, headers, maxRedirects: 0,
      });

      const logout = await page.request.post(hosted + "/logout", { headers, maxRedirects: 0 });

      expect(login.status()).toBe(403);
      expect(login.headers()["set-cookie"]).toBeUndefined();
      expect(logout.status()).toBe(403);
      expect(logout.headers()["set-cookie"]).toBeUndefined();
    }

    const stillSignedIn = await page.request.get(hosted + "/app/", { maxRedirects: 0 });
    const retainedCookie = (await page.context().cookies()).find((entry) => entry.name === "jmp_session");

    expect(stillSignedIn.status()).toBe(200);
    expect(stillSignedIn.headers()["referrer-policy"]).toBe("no-referrer");
    expect(retainedCookie?.value === cookie?.value).toBe(true);

    // Simulate a session lost after the dashboard is already open.
    await page.context().clearCookies({ name: "jmp_session" });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(hosted + "/login?next=%2Fapp%2F");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("invented");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-password-0123456789");
    expect((await submitLogin(page)).status()).toBe(303);
    await expect(page).toHaveURL(hosted + "/app/");
    await expect(page.getByRole("link", { name: "Job Market Pulse", exact: true })).toBeVisible();

    const logout = await page.request.post(hosted + "/logout", { headers: { origin: hosted }, maxRedirects: 0 });

    expect(logout.status()).toBe(303);
    expect((await page.request.get(hosted + "/app/", { maxRedirects: 0 })).status()).toBe(303);
  });

  test("a browser cannot make an eleventh failed login in one address window", async ({ request }) => {
    for (let index = 0; index < 10; index++) {
      const failed = await request.post(hosted + "/login", { form: { username: "wrong", password: "wrong" }, headers: { "x-real-ip": "192.0.2.10", origin: hosted }, maxRedirects: 0 });

      expect(failed.status()).toBe(401);
      expect(failed.headers()["set-cookie"]).toBeUndefined();
    }

    const limited = await request.post(hosted + "/login", { form: { username: "invented", password: "synthetic-password-0123456789" }, headers: { "x-real-ip": "192.0.2.10", origin: hosted }, maxRedirects: 0 });

    expect(limited.status()).toBe(429);
    expect(limited.headers()["retry-after"]).toBe("900");
  });
});
