import { Schema } from "effect";

export const NtfyTopic = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{24,64}(?![\s\S])/));

export const DashboardLink = Schema.String.pipe(Schema.maxLength(512), Schema.filter((text) => {
  if (!/^https:\/\/[^/]/u.test(text) || /[\p{Cc}\p{Cf}\s\\?#]/u.test(text)) return false;
  const url = URL.parse(text);
  const authority = text.slice(8).split("/", 1)[0];

  return url !== null && authority !== undefined && !authority.includes("@");
}));

export const NtfySettingsInput = Schema.Struct({
  enabled: Schema.Boolean,
  dashboard_url: Schema.NullOr(DashboardLink),
  // An empty input is sent as null to keep the saved topic.
  topic: Schema.NullOr(NtfyTopic),
});

export type NtfySettingsInput = typeof NtfySettingsInput.Type;

export const isNtfyTopic = Schema.is(NtfyTopic);
export const isDashboardLink = Schema.is(DashboardLink);
