// Render every icon file from the one master SVG: desktop/icons/icon.svg.
// Run: bun run icons. It uses the pinned Playwright Chromium (bun run setup:browser)
// and downloads nothing.
import { chromium } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const master = join(root, "desktop/icons/icon.svg");
const svg = readFileSync(master, "utf8");
const pngSizes = [64, 512] as const;

const iconPage = (size: number) =>
  `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`;

const socialPage = () => `<html><body style="margin:0;width:1280px;height:640px;background:#2B3A55;display:flex;align-items:center;justify-content:center;gap:56px;font-family:'DejaVu Sans',Arial,sans-serif">
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="300" height="300">
<div style="color:#F4EFE6"><div style="font-size:76px;font-weight:700;line-height:1.1">Job Market Pulse</div>
<div style="font-size:32px;margin-top:20px;color:#FF7A59">Follow the Norwegian job market</div></div></body></html>`;

const browser = await chromium.launch();

try {
  for (const size of pngSizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(iconPage(size));
    writeFileSync(join(root, `desktop/icons/icon-${size}.png`), await page.screenshot({ omitBackground: true }));
    await page.close();
  }

  const social = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await social.setContent(socialPage());
  writeFileSync(join(root, "desktop/icons/social-preview.png"), await social.screenshot());

  mkdirSync(join(root, "docs/assets"), { recursive: true });
  copyFileSync(master, join(root, "static/favicon.svg"));
  copyFileSync(join(root, "desktop/icons/icon-64.png"), join(root, "static/favicon.png"));
  copyFileSync(master, join(root, "docs/assets/logo.svg"));
  copyFileSync(join(root, "desktop/icons/icon-64.png"), join(root, "docs/assets/favicon.png"));
} finally {
  await browser.close();
}

console.log("Wrote icons from desktop/icons/icon.svg");
