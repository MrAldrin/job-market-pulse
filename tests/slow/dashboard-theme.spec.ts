import { expect, test, type Locator } from "@playwright/test";
import { b8Origin, localSettingsOrigin as editorOrigin } from "./origins.ts";

async function contrast(locator: Locator, sample: "text" | "border" | "outline", inside = false): Promise<number> {
  return locator.evaluate((element, { sample, inside }) => {
    const canvas = document.createElement("canvas");

    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");

    if (!context) throw new Error("Could not create a canvas for sRGB conversion");

    const luminance = (): number => {
      const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;

      const linear = (channel: number): number => {
        const value = channel / 255;

        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };

      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };

    const backgrounds: string[] = [];

    for (let node: Element | null = sample === "text" || inside ? element : element.parentElement; node; node = node.parentElement) {
      backgrounds.unshift(getComputedStyle(node).backgroundColor);
    }

    for (const color of backgrounds) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }

    const background = luminance();

    const style = getComputedStyle(element);

    context.fillStyle = { text: style.color, border: style.borderTopColor, outline: style.outlineColor }[sample];
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();

    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  }, { sample, inside });
}

test("dashboard follows the device theme and keeps text readable", async ({ page }) => {
  const body = page.locator("body");
  const card = page.getByRole("article").first();

  const samples = {
    page: body,
    "current navigation link": page.getByRole("navigation").locator('[aria-current="page"]'),
    "job title": card.getByRole("link").first(),
    "job metadata": card.locator("p.text-muted-foreground"),
    "fit badge": card.locator("span.bg-signal-positive"),
  };

  async function expectTheme(scheme: "light" | "dark"): Promise<void> {
    await expect(body).toHaveCSS("color-scheme", scheme);
    await expect(body).toHaveCSS("background-color", scheme === "dark" ? "oklch(0.145 0 0)" : "oklch(1 0 0)");

    for (const [label, locator] of Object.entries(samples)) {
      await expect(locator).toBeVisible();
      expect(await contrast(locator, "text"), `${scheme}: ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  }

  for (const initial of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: initial });
    await page.goto(`${b8Origin}/app/`);
    await expectTheme(initial);

    const next = initial === "light" ? "dark" : "light";

    await page.emulateMedia({ colorScheme: next });
    await expectTheme(next);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`empty fields have visible borders and keyboard focus in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });

    const fields = [
      { url: `${b8Origin}/app/#/jobs`, label: "Search title or employer", role: "searchbox" },
      { url: `${editorOrigin}/app/#/settings`, label: "New title term", role: "textbox" },
    ] as const;

    for (const { url, label, role } of fields) {
      await page.goto(url);
      const field = page.getByRole(role, { name: label, exact: true });

      await expect(field).toBeVisible();
      await expect(field).toHaveValue("");
      await expect(field).not.toBeFocused();
      await expect(field).toHaveCSS("border-top-width", "1px");
      expect(await contrast(field, "border"), `${label}: border against page`).toBeGreaterThanOrEqual(3);
      expect(await contrast(field, "border", true), `${label}: border against fill`).toBeGreaterThanOrEqual(3);

      await field.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(field).not.toBeFocused();
      await page.keyboard.press("Tab");
      await expect(field).toBeFocused();
      await expect(field.and(page.locator(":focus-visible"))).toHaveCount(1);
      await expect(field).toHaveCSS("outline-style", "solid");
      await expect(field).toHaveCSS("outline-width", "2px");
      await expect(field).toHaveCSS("outline-offset", "2px");
      expect(await contrast(field, "outline"), `${label}: focus against page`).toBeGreaterThanOrEqual(3);
    }
  });
}
