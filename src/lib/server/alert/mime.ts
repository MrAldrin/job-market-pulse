import type { StagePayload } from "../../contracts/alert.ts";

const base64Lines = (value: string): string => Buffer.from(value.replace(/\r\n?/g, "\n").replace(/\n?$/, "\n"), "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";

const subject = (title: string): string => {
  if (/^[\x20-\x7e]{1,68}$/.test(title)) return title;
  const words: string[] = [];
  let current = "";

  for (const character of title) {
    if (Buffer.byteLength(current + character, "utf8") > 42) { words.push(`=?utf-8?b?${Buffer.from(current).toString("base64")}?=`); current = ""; }

    current += character;
  }

  if (current) words.push(`=?utf-8?b?${Buffer.from(current).toString("base64")}?=`);

  return words.join("\r\n ");
};

// Staging retains private MIME, but no private MIME transport is registered.
// Content identity is the unchanged canonical ledger hash, not transfer encoding.
export const mimeBytes = (payload: Pick<StagePayload, "title" | "plain_text" | "html">, hash: string): Uint8Array => {
  const part = (type: "plain" | "html", body: string) => `Content-Type: text/${type}; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}\r\n`;
  const header = `Subject: ${subject(payload.title)}\r\nMIME-Version: 1.0\r\n`;

  if (payload.html === null) return new TextEncoder().encode(header + part("plain", payload.plain_text));
  const boundary = `pulse-${hash.slice(0, 32)}`;

  return new TextEncoder().encode(`${header}Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${part("plain", payload.plain_text)}\r\n--${boundary}\r\n${part("html", payload.html)}\r\n--${boundary}--\r\n`);
};
