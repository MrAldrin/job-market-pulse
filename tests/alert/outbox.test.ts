import { describe, expect, it } from "vitest";
import { artifactNames, canonicalPayload, digestKeyFor, payloadHash, pushPreviewBytes } from "../../src/lib/server/alert/core.ts";

describe("delivery canonical core", () => {
  const content = {
    title: "Title", plain_text: "Body", html: null,
    items: [{ id: "b", version: "v2" }, { id: "a", version: "v1" }],
  };

  it("sorts items and hashes the frozen compact JSON representation", () => {
    expect(canonicalPayload(content)).toBe('{"html":null,"items":[{"id":"a","version":"v1"},{"id":"b","version":"v2"}],"plain_text":"Body","title":"Title"}');
    expect(payloadHash(content)).toBe("f4c63a7fbaca74d384f354773af54b8342215914aa7b895c0da77923e12c528a");
    expect(digestKeyFor(content)).toBe(`sha256:${payloadHash(content)}`);
    expect(payloadHash({ ...content, items: [...content.items].reverse() })).toBe(payloadHash(content));
  });

  it("keeps push content generic and artifact filenames opaque", () => {
    expect(new TextDecoder().decode(pushPreviewBytes())).toBe('{\n  "body": "A job-market update is ready for local review.",\n  "title": "Job Market Pulse"\n}\n');
    expect(artifactNames("key").eml).toMatch(/^[0-9a-f]{64}\.eml$/);
  });
});
