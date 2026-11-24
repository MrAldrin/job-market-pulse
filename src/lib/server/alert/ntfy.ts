import { Context, Effect, Layer, Redacted } from "effect";
import type { SnapshotDocument } from "../../contracts/snapshot.ts";

export interface NtfyMessage {
  readonly title: string;
  readonly message: string;
  readonly click?: string;
}

// Only an acknowledgement matters. Do not retain the response or thrown error.
export const ntfyTransport = (send: (url: string, init: RequestInit) => Promise<Response>) => ({
  post: (topic: Redacted.Redacted<string>, message: NtfyMessage) => Effect.tryPromise({
    try: async (signal) => {
      const response = await send("https://ntfy.sh", {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: Redacted.value(topic), ...message }),
      });

      await response.body?.cancel();

      return response.ok;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false), Effect.timeoutTo({ duration: "5 seconds", onTimeout: () => false, onSuccess: (ok) => ok })),
});

export class NtfyTransport extends Context.Tag("pulse/NtfyTransport")<NtfyTransport, ReturnType<typeof ntfyTransport>>() {}

export const NtfyTransportLive = Layer.succeed(NtfyTransport, ntfyTransport((input, init) => fetch(input, init)));

export const scheduledFailureMessage: NtfyMessage = {
  title: "Job Market Pulse: scheduled run failed", message: "Check the latest scheduled run on your computer.",
};

export const testNtfyMessage: NtfyMessage = {
  title: "Job Market Pulse: test notification", message: "This is a test from local settings.",
};

const topJobs = ({ jobs }: SnapshotDocument) => jobs.filter(({ status, assessment }) => status === "open" && assessment.fit === "exceptional");
export const topJobIds = (snapshot: SnapshotDocument) => new Set(topJobs(snapshot).map(({ id }) => id));

const cleanLabel = (text: string, topic: string): string => [...text
  .replaceAll(topic, "[redacted]")
  .replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, 120).join("");

export const newTopJobsMessage = (
  before: ReadonlySet<string>, after: SnapshotDocument, click: string, topic: Redacted.Redacted<string>,
): NtfyMessage | null => {
  const jobs = topJobs(after).filter(({ id }) => !before.has(id));

  if (!jobs.length) return null;
  const secret = Redacted.value(topic);
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let size = 0;

  for (const { title, employer } of jobs) {
    const line = `${cleanLabel(title, secret)} — ${cleanLabel(employer, secret)}`;
    size += encoder.encode(line).byteLength + 1;

    if (size > 3800) break;
    lines.push(line);
  }

  if (lines.length < jobs.length) lines.push(`And ${jobs.length - lines.length} more. Open the dashboard to see all matches.`);

  return {
    title: `Job Market Pulse: ${jobs.length === 1 ? "1 new exceptional match" : `${jobs.length} new exceptional matches`}`,
    message: lines.join("\n"), click,
  };
};
