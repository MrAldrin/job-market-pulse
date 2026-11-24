import { Either } from "effect";
import { digestTimestamp, DigestListingUrl, type Digest, type DigestCandidate } from "../../contracts/select.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { pythonJson } from "../shared/python-json.ts";
import { strip } from "../shared/text.ts";
import { DigestInputError } from "./errors.ts";

const salary = (candidate: DigestCandidate) => candidate.salary ?? "Lønn ukjent";

const display = (value: string, maximum: number): string => {
  const characters = Array.from(value);

  if (characters.length <= maximum) return value;
  let prefix = characters.slice(0, maximum - 1);
  const boundary = prefix.lastIndexOf(" ");

  if (boundary >= Math.floor(maximum / 2)) prefix = prefix.slice(0, boundary);

  while (prefix.length && strip(prefix.at(-1) ?? "") === "") prefix.pop();

  return prefix.join("") + "…";
};

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const uncertainty = (candidate: DigestCandidate): string => {
  if (!candidate.uncertainties.length) return "No additional uncertainty was supplied.";
  const shown = candidate.uncertainties.slice(0, 3).map((item) => display(item, 96));

  if (candidate.uncertainties.length > 3) shown.push(`${candidate.uncertainties.length - 3} more omitted`);

  return shown.join("; ");
};

const marketItems = (digest: Digest): readonly string[] => {
  if (digest.market_context === null) return [];
  // Python str.splitlines includes these control and Unicode line separators.
  // eslint-disable-next-line no-control-regex
  const lines = digest.market_context.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u).map(strip).filter(Boolean);
  const shown = lines.slice(0, 4).map((line) => display(line, 500));

  if (lines.length > 4) shown.push(`${lines.length - 4} more omitted`);
  shown.push("Not a whole-market estimate. Coverage and significance were not checked.");

  return shown;
};

const blockedText = (digest: Digest) => digest.blocked_reasons.includes("funnel_unverified")
  ? "Digest blocked: your review store could not be read, so no jobs are shown."
  : "Digest blocked: input is incomplete, stale, or uncertain.";

const quietText = "I did not find any relevant jobs this time.";
const readyText = "Good jobs I found for you that could be relevant are below.";
const bullets = (items: readonly string[]) => items.map((item) => "- " + item);
const htmlBullets = (items: readonly string[]) => items.length ? "<ul>" + items.map((item) => "<li>" + escape(item) + "</li>").join("") + "</ul>" : "";
const details = (candidate: DigestCandidate) => [`Fit: ${candidate.fit}`, `Why: ${display(candidate.reason, 320)}`, `Uncertainty: ${uncertainty(candidate)}`];
const validateUrls = (digest: Digest) => digest.status !== "ready" ? Either.right(digest) : Either.map(Either.all(digest.candidates.map((candidate) => Either.mapLeft(decodeStrict(DigestListingUrl)(candidate.url), () => new DigestInputError({ message: "candidate.url must be a NAV listing URL" })))), () => digest);

const text = (digest: Digest): string => {
  if (digest.status === "blocked") return blockedText(digest);

  if (digest.status === "quiet") return "Job market digest\n\n" + quietText;
  const market = marketItems(digest);
  const lines = ["Job market digest", "", ...(market.length ? ["Your reviewed jobs:", ...bullets(market)] : []), ""];
  lines.push(digest.candidates.length ? readyText : quietText);

  if (digest.candidates.length) lines.push("");

  for (const candidate of digest.candidates) lines.push(
    display(candidate.title, 160) + " — " + display(candidate.employer, 120), display(salary(candidate), 160),
    ...bullets(details(candidate)), "Source: " + candidate.url, "",
  );

  return lines.join("\n").trimEnd();
};

const html = (digest: Digest): string => {
  const styles = "body{box-sizing:border-box;font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem;color:#17202a}article{border:1px solid #ccd2d8;border-radius:.6rem;padding:1rem;margin:1rem 0}h1{font-size:1.5rem}h2{font-size:1.15rem;line-height:1.3;margin:.2rem 0}.salary{margin:.15rem 0;font-weight:600}.employer{margin:.25rem 0 .8rem;color:#44515d}ul{margin:.4rem 0 .8rem;padding-left:1.2rem}li{margin:.15rem 0}a{overflow-wrap:anywhere}";
  const market = marketItems(digest);
  const marketHtml = market.length ? '<section aria-label="Your reviewed jobs"><h2>Your reviewed jobs</h2>' + htmlBullets(market) + "</section>" : "";

  const body = digest.status === "blocked" ? '<p role="status">' + escape(blockedText(digest)) + "</p>"
    : marketHtml + '<p role="status">' + (digest.status === "quiet" || !digest.candidates.length ? quietText : readyText) + "</p>"
      + (digest.status === "quiet" ? "" : digest.candidates.map((candidate) => "<article><h2>" + escape(display(candidate.title, 160))
        + '</h2><p class="salary">' + escape(display(salary(candidate), 160)) + '</p><p class="employer">' + escape(display(candidate.employer, 120))
        + "</p>" + htmlBullets(details(candidate)) + '<p><a href="' + escape(candidate.url) + '">View source listing on NAV</a></p></article>').join(""));

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job market digest</title><style>' + styles + "</style></head><body><h1>Job market digest</h1>" + body + "</body></html>";
};

export const renderText = (digest: Digest) => Either.map(validateUrls(digest), text);
export const renderHtml = (digest: Digest) => Either.map(validateUrls(digest), html);

const candidateJson = (candidate: DigestCandidate) => ({
  id: candidate.id, version: candidate.version, title: candidate.title, employer: candidate.employer, url: candidate.url,
  fit: candidate.fit, reason: candidate.reason, hard_constraints: candidate.hard_constraints,
  assessed_at: digestTimestamp(candidate.assessed_at), expires_at: candidate.expires_at === null ? null : digestTimestamp(candidate.expires_at),
  uncertainties: candidate.uncertainties, salary: salary(candidate),
});

export const digestJson = (digest: Digest) => Either.map(validateUrls(digest), (value) => ({
  schema_version: 1, profile_id: value.profile_id, profile_fingerprint: value.profile_fingerprint, pack: value.pack,
  as_of: digestTimestamp(value.as_of), status: value.status, blocked_reasons: value.blocked_reasons,
  candidates: value.candidates.map(candidateJson), text: text(value), html: html(value),
}));

export const encodeDigestJson = (digest: Digest) => Either.map(digestJson(digest), (value) => pythonJson(value, false, true));
