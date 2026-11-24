import { createHash } from "node:crypto";
import type { DeliveryItem, StagePayload } from "../../contracts/alert.ts";
import { codepointOrder } from "../shared/python-json.ts";

export const PUSH_PREVIEW = {
  title: "Job Market Pulse",
  body: "A job-market update is ready for local review.",
} as const;

export type DigestContent = Pick<StagePayload, "title" | "plain_text" | "html" | "items">;

export const compareItems = (a: DeliveryItem, b: DeliveryItem): number =>
  codepointOrder(a.id, b.id) || codepointOrder(a.version, b.version);

export const canonicalPayload = (content: DigestContent): string => JSON.stringify({
  html: content.html,
  items: [...content.items].sort(compareItems).map(({ id, version }) => ({ id, version })),
  plain_text: content.plain_text,
  title: content.title,
});

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const payloadHash = (content: DigestContent): string => sha256(canonicalPayload(content));
export const digestKeyFor = (content: DigestContent): string => `sha256:${payloadHash(content)}`;

export const artifactNames = (digestKey: string) => {
  const token = sha256(digestKey);

  return { eml: `${token}.eml`, html: `${token}.html`, pushPreview: `${token}.push-preview.json` };
};

export const pushPreviewBytes = (): Uint8Array => new TextEncoder().encode(`${JSON.stringify({
  body: PUSH_PREVIEW.body,
  title: PUSH_PREVIEW.title,
}, null, 2)}\n`);
