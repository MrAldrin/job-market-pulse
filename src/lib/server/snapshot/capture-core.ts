import { unescapeHtml } from "../shared/html.ts";

const encode = (value: string) => new TextEncoder().encode(value);
export const noDigestPage = () => encode("<!doctype html><meta charset=utf-8><title>Digest</title><p>No digest staged; see the dashboard views.</p>");
const placeholder = (reason: string) => encode(`<!doctype html><meta charset=utf-8><title>Digest</title><p>No new digest. The last stored digest ${reason}, so it is not shown.</p>`);

export const safeDigestPage = (html: Uint8Array, funnel: ReadonlySet<string>): { readonly html: Uint8Array; readonly warning: string | null } => {
  const text = new TextDecoder().decode(html);
  const normalized = unescapeHtml(text).toLowerCase();
  const allowed = new Set([...funnel].flatMap((id) => id ? [id.toLowerCase()] : []));
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const paths = /stillinger\/stilling\/?([a-z0-9_-]*)/g;
  const links = /(?:(?:https?):)?(?:\/\/)?arbeidsplassen\.nav\.no\/stillinger\/stilling\/([a-z0-9_-]{1,128})/g;

  const valid = [...normalized.matchAll(uuid)].every((match) => allowed.has(match[0]))
    && [...normalized.matchAll(paths)].every((match) => allowed.has(match[1] ?? ""))
    && normalized.split("arbeidsplassen").length - 1 === [...normalized.matchAll(links)].filter((match) => allowed.has(match[1] ?? "")).length;

  const reason = text.includes("Market changes") ? "predates the reviewed-jobs rule" : valid ? null : "links to jobs outside your reviewed set";

  return reason === null ? { html, warning: null } : {
    html: placeholder(reason),
    warning: `WARNING: stored digest not shown: it ${reason}. Dashboard pages were captured; the digest page is a placeholder.`,
  };
};
