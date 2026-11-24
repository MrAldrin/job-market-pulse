import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { unescapeHtml } from "../../src/lib/server/shared/html.ts";
import { scrubContactDetails } from "../../src/lib/server/source/scrub.ts";
import { sourceTopics } from "../../src/lib/server/source/topics.ts";

describe("shared HTML character references", () => {
  it("keeps complete and legacy prefix matches, not recursive replacements", () => {
    expect(unescapeHtml("&NotEqualTilde; &notit; &ampersand &madeup; &amp;lt; &acE;")).toBe("≂̸ ¬it; &ersand &madeup; &lt; ∾̳");
  });
  it("uses numeric overrides, not control or noncharacter output", () => {
    expect(unescapeHtml("&#0;&#13;&#128;&#129;&#8;&#11;&#127;&#xD800;&#1114112;&#xFDD0;&#x1FFFF;&#x10FFFF;&#x1F600;")).toBe("�\r€\x81��😀");
    expect(unescapeHtml("&#x; &#; &#65tail &#x41tail &#x41;tail")).toBe("&#x; &#; Atail Atail Atail");
  });
  it("never recursively processes newly decoded ampersands", () => fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
    expect(unescapeHtml("&" + "amp;".repeat(n) + "lt;")).toBe("&" + "amp;".repeat(n - 1) + "lt;");
  })));
});

describe("minimized ingest descriptions", () => {
  it("removes contact data after entities and tags, preserving visible anchor and pay", () => {
    expect(scrubContactDetails('<p>Lønn kr 650 000. Søk <a href="https://private.example/x">her</a> hos ægir&#64;firma.no. Ring +47 22.33.44.55.</p>')).toBe("Lønn kr 650 000. Søk her hos [e-post]. Ring [telefon].");
    expect(scrubContactDetails("Se HTTPS://firma.no/a og www.firma.no/x, ola.nordmann [AT] firma.no")).toBe("Se [lenke] og [lenke], [e-post]");
  });
  it("distinguishes neighboring phones from dates, pay and organization IDs", () => {
    expect(scrubContactDetails("22334455/91234567; +47 22 33 44 55/91 23 45 67")).toBe("[telefon]/[telefon]; [telefon]/[telefon]");
    expect(scrubContactDetails("28.10.2026-29.10.2026 kr.600 000 mill.Neste org.nr 123456789")).toBe("28.10.2026-29.10.2026 kr.600 000 mill.Neste org.nr 123456789");
    expect(scrubContactDetails("Ring 𝟡𝟙𝟚 𝟛𝟜 𝟝𝟞𝟟, 91\u200b23\u00ad45 67")).toBe("Ring [telefon], [telefon]");
  });
  it("preserves line feeds and Python whitespace behavior", () => {
    expect(scrubContactDetails("\u001f A\u0085 B\r\nC \u001c")).toBe("A B \nC");
    expect(scrubContactDetails("Se firma.as og jobb.example.io/x, men mill.Neste")).toBe("Se [lenke] og [lenke], men mill.Neste");
  });
  it("runs bounded repeated near-matches without losing data", () => {
    for (const value of ["a".repeat(200000), "a.".repeat(100000), "1 ".repeat(100000), "x [at] ".repeat(30000)]) expect(scrubContactDetails(value)).toBe(value.trim());
  }, 10000);
});

it("collects broad fixed topics without admitting jobs", () => {
  expect(sourceTopics("DATA SCIENTIST med Python og SQL / maskinlæring")).toEqual(["data science", "AI / machine learning", "programming", "databases / data engineering"]);
  expect(sourceTopics("øpython Pythonı databaser")).toEqual(["databases / data engineering"]);
});
