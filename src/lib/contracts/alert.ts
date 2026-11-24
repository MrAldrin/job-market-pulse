import { Schema } from "effect";

const text = (newlines = false, empty = false) => Schema.String.pipe(Schema.filter((value) => (empty || value.trim().length > 0)
  && !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return (code < 32 && !(newlines && "\r\n\t".includes(character))) || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff);
  })));

export const DeliveryProfileId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$(?![\s\S])/));
export const DeliveryItem = Schema.Struct({ id: text(), version: text() });

export type DeliveryItem = typeof DeliveryItem.Type;

export const DeliveryStatus = Schema.Literal("staged", "delivered", "failed", "uncertain");

export type DeliveryStatus = typeof DeliveryStatus.Type;

export const StagePayload = Schema.Struct({
  profile_id: DeliveryProfileId, digest_key: text(), title: text(), plain_text: text(true, true),
  html: Schema.NullOr(text(true, true)), items: Schema.Array(DeliveryItem),
}).pipe(Schema.filter((value) => new Set(value.items.map((item) => item.id)).size === value.items.length));

export type StagePayload = typeof StagePayload.Type;

export const StagedDigest = Schema.Struct({
  profile_id: DeliveryProfileId, digest_key: text(), status: DeliveryStatus, created_at: Schema.String, updated_at: Schema.String,
  eml_path: Schema.String, html_path: Schema.NullOr(Schema.String), push_preview_path: Schema.String,
});

export type StagedDigest = typeof StagedDigest.Type;

export interface ReadOnlyDigest {
  readonly staged: StagedDigest;
  readonly payload_hash: string;
  readonly has_html: boolean;
  readonly items: readonly DeliveryItem[];
}

export interface DeliveryPayload {
  readonly content: Uint8Array;
  readonly content_type: "application/json";
  readonly filename: "push-preview.json";
}

export type TransportOutcome = "accepted" | "rejected" | "uncertain";

export interface DispatchApprovalSummary {
  readonly profile_id: string;
  readonly digest_key_fingerprint: string;
  readonly status: DeliveryStatus;
  readonly channel: "redacted_discord";
  readonly sensitivity: "redacted_preview";
  readonly payload_fingerprint: string;
  readonly artifact_fingerprint: string;
  readonly destination_fingerprint: string;
}

export interface DispatchResult {
  readonly profile_id: string;
  readonly digest_key: string;
  readonly channel: "redacted_discord";
  readonly status: DeliveryStatus;
  readonly diagnostic_code: string | null;
}
