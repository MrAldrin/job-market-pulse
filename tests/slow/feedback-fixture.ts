import { createConnection } from "node:net";

// Invented settings for the loopback-only feedback server.
export const feedbackOrigin = "http://127.0.0.1:4177";
export const feedbackAlias = "localhost:4177";
export const feedbackToken = "synthetic-loopback-feedback-bearer_0123456789";
export const feedbackHost = new URL(feedbackOrigin).host;
export const feedbackPath = "/app/shortlist-feedback";
export const legacyFeedbackPath = "/shortlist-feedback";
export const disabledFeedbackOrigin = "http://localhost:4174";

export const dotTarget = (path: string) => path.replace(/\/([^/]+)$/, "/./$1");

// Write the request line literally. Fetch and URL constructors can normalize it.
export async function literalFeedbackStatus(
  target: string, host = feedbackHost, method: "GET" | "HEAD" | "POST" = "GET",
  headers: Readonly<Record<string, string>> = {}, body?: string, capability: "enabled" | "disabled" = "enabled",
): Promise<number> {
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${host}`, "Connection: close"];

  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);

  if (body !== undefined) lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
  const port = new URL(capability === "enabled" ? feedbackOrigin : disabledFeedbackOrigin).port;
  const socket = createConnection({ host: "127.0.0.1", port: Number(port), signal: AbortSignal.timeout(5_000) });
  let prefix = "";

  try {
    socket.setEncoding("latin1");
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);

    for await (const chunk of socket) {
      prefix += String(chunk).slice(0, 128 - prefix.length);
      const end = prefix.indexOf("\r\n");

      if (end === -1 && prefix.length < 128) continue;
      const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(prefix.slice(0, end));

      if (match && end >= 0) return Number(match[1]);
      break;
    }

    throw new Error("Invalid loopback status line");
  } finally {
    socket.destroy();
  }
}
