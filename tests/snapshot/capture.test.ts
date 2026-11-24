import { expect, it } from "vitest";
import { safeDigestPage } from "../../src/lib/server/snapshot/capture-core.ts";

it("captures explicit v2 privately without pages and preserves SQLite when companion JSON fails", async () => { await import("./capture-bun.ts"); }, 25_000);

it("replaces entity-encoded foreign digest links without copying their job text", () => {
  const html = new TextEncoder().encode('<p>foreign secret</p><a href="https://arbeidsplassen.nav.no/stillinger&#47;stilling/foreign">job</a>');
  const listingId = "00000000-0000-4000-8000-000000000001";
  const safe = safeDigestPage(html, new Set([listingId]));

  expect(safe.warning).not.toBeNull();
  expect(new TextDecoder().decode(safe.html)).not.toContain("foreign secret");
  const allowed = new TextEncoder().encode(`<a href="https://arbeidsplassen.nav.no/stillinger/stilling/${listingId}">Software developer</a>`);

  expect(safeDigestPage(allowed, new Set([listingId])).html).toBe(allowed);
});
