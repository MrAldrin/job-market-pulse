import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const home = process.env.HOME ?? "";
const fetchLoopback = globalThis.fetch;

const fakeFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  if (url.hostname === "127.0.0.1") return fetchLoopback(input, init);

  if (url.href === "https://pam-stilling-feed.nav.no/api/publicToken") return new Response("eyJsynthetic.pulse.smoke");

  if (url.href !== "https://pam-stilling-feed.nav.no/api/v1/feed?last") throw new Error(`Unexpected smoke request: ${url.origin}${url.pathname}`);

  await appendFile(join(home, "calls"), "Feed\n");

  // Hold Source in progress until the test releases it or the app closes.
  // A permanent reply then gives the dashboard a real stopped run to reset.
  while (!(await stat(join(home, "release-feed")).then(() => true, () => false))) {
    await pause(50, undefined, { signal: init?.signal ?? undefined });
  }

  return new Response("Synthetic source failure", { status: 400 });
}, { preconnect: fetchLoopback.preconnect });

globalThis.fetch = fakeFetch;
