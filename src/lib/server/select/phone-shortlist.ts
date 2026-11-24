import { Context, Effect, Layer, Option } from "effect";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { hasRejectedTextCharacter } from "../shared/text.ts";
import { SelectResourceError } from "./errors.ts";
import { selectShortlist, shortlistRule, type SavedCandidate, type SelectMode } from "./shortlist-select.ts";

export const SEEN_SCRIPT = `(() => {
  const root = document.querySelector('[data-shortlist]');
  if (!root) return;
  const duration = 3 * 24 * 60 * 60 * 1000;
  const cards = [...root.querySelectorAll('[data-job]')];
  const key = card => 'jmp-shortlist-v1:' + root.dataset.shortlist + ':' + card.dataset.job;
  const read = card => {
    try { const n = Number(localStorage.getItem(key(card))); return n > 0 ? n : null; }
    catch (_) { return null; }
  };
  const update = () => cards.forEach(card => {
    const seen = read(card);
    const fresh = seen === null || Date.now() - seen < duration;
    card.classList.toggle('is-new', fresh);
    card.querySelector('.new-label').hidden = !fresh;
  });
  const observer = new IntersectionObserver(entries => {
    if (document.visibilityState !== 'visible') return;
    entries.forEach(entry => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.25) return;
      const card = entry.target;
      if (read(card) === null) {
        try { localStorage.setItem(key(card), String(Date.now())); } catch (_) {}
      }
    });
    update();
  }, {threshold: 0.25});
  cards.forEach(card => observer.observe(card));
  document.addEventListener('visibilitychange', () => {
    update();
    cards.forEach(card => { observer.unobserve(card); observer.observe(card); });
  });
  window.addEventListener('storage', update);
  setInterval(update, 60000);
  update();
})();`;

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
const unconfirmed = new Set(["saved_source_unconfirmed", "current_status_unknown", "expiry_unverified", "earlier_refresh"]);
const omitted = new Set(["earlier_refresh", "expiry_unverified"]);

export const renderShortlist = (candidates: readonly SavedCandidate[], profileId: string, mode: SelectMode, firstFound: Readonly<Record<string, string>>, now: Date): Uint8Array => {
  const cards = selectShortlist(candidates, firstFound, mode).map((candidate) => {
    const review = candidate.full_review!;
    const found = firstFound[candidate.listing_id];
    const deadline = candidate.application_due || candidate.expires_at;
    const fit = review.fit ?? "";

    return `<article class="job is-new" data-job="${escape(candidate.listing_id)}">`
      + '<span class="new-label">New</span>' + `<h2>${escape(candidate.title)}</h2>`
      + `<p class="employer">${escape(candidate.employer)}</p><p>${escape(review.reason ?? "")}</p>`
      + `<p class="meta">${escape(fit.charAt(0).toUpperCase() + fit.slice(1).toLowerCase())} match · First found: ${escape(found === undefined ? "Not recorded" : Array.from(found).slice(0, 10).join(""))}</p>`
      + (deadline ? `<p class="meta">Deadline: ${escape(deadline)}</p>` : "")
      + (unconfirmed.has(candidate.lifecycle_status) ? '<p class="meta">Source status unconfirmed</p>' : "")
      + `<a class="job-link" href="${escape("https://arbeidsplassen.nav.no/stillinger/stilling/" + candidate.listing_id)}">View job →</a></article>`;
  });

  const empty = '<section class="empty"><h2>No current recommendations yet</h2><p>Recommendations will appear here when saved reviews find a match. Refreshing without new matches will not clear your shortlist.</p></section>';
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${pad(now.getUTCDate())} ${months[now.getUTCMonth()]} ${now.getUTCFullYear()} at ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;

  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your job shortlist</title><style>'
    + 'body{margin:0;background:#f4f6f8;color:#172b3a;font:17px/1.5 system-ui,sans-serif}'
    + 'main{max-width:680px;margin:auto;padding:28px 18px 48px}'
    + 'h1{font-size:2rem;line-height:1.15;margin-bottom:8px}h2{font-size:1.22rem;margin:10px 0 4px}'
    + '.intro,.meta{color:#526574}.meta{font-size:.87rem}.employer{margin-top:0;font-weight:600}'
    + '.job,.empty{background:white;border:2px solid #dce3e9;border-radius:14px;padding:20px;margin:20px 0}'
    + '.job.is-new{border-color:#247b72;box-shadow:0 0 0 1px #247b72}'
    + '.new-label{display:inline-block;background:#d9f2e8;color:#14584f;padding:2px 10px;border-radius:20px;font-size:.8rem;font-weight:700}'
    + '[hidden]{display:none!important}a{color:#17675f}.job-link{font-weight:650}'
    + 'footer{max-width:680px;margin:auto;padding:0 18px 28px}'
    + `</style></head><body><main data-shortlist="${escape(profileId)}"><h1>Your job shortlist</h1><p class="intro">Saved matches</p><p class="intro">${escape(shortlistRule(mode))}</p><p class="meta">Updated ${escape(date)}</p><p>Good matches stay here across refreshes, until closed or expired.</p>`
    + (cards.length ? cards.join("") : empty)
    + '<p class="meta">New borders stay until you see a job, then for three days. This browser remembers; another browser may show them as new again.</p><noscript><p>Enable JavaScript to remember which jobs you have seen.</p></noscript>'
    + `</main><script>${SEEN_SCRIPT}</script></body></html>`;

  return new TextEncoder().encode(page);
};

export const summaryText = (value: string | null, maxLength: number): string | null => value !== null && value.length > 0 && Array.from(value).length <= maxLength && !hasRejectedTextCharacter(value) ? value : null;

export const summaryExpiry = (value: string | null): string | null => {
  if (!value) return null;

  const parsed = parseIsoTime(value);

  if (Option.isNone(parsed) || !parsed.value.aware) return null;

  const micros = parsed.value.epochMicros;
  const seconds = micros >= 0n ? micros / 1_000_000n : (micros - 999_999n) / 1_000_000n;
  const date = new Date(Number(seconds) * 1000);

  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;

  return date.toISOString().slice(0, 19) + "+00:00";
};

export const starredSummary = (candidate: SavedCandidate) => ({
  title: summaryText(candidate.title, 512), employer: summaryText(candidate.employer, 512),
  deadline: summaryText(candidate.application_due, 512), expires_at: summaryExpiry(candidate.expires_at),
  source_status: "unknown" as const, source_version: summaryText(candidate.source_version, 128), source_checked_at: null,
});

export interface SavedReviewRead {
  readonly verified: boolean;
  readonly listingIds: readonly string[];
  readonly candidates: readonly SavedCandidate[];
  readonly firstFound: Readonly<Record<string, string>>;
}

export class SavedReviewResource extends Context.Tag("pulse/SavedReviewResource")<SavedReviewResource, {
  readonly read: Effect.Effect<SavedReviewRead, SelectResourceError>;
}>() {}

export class PhoneShortlist extends Context.Tag("pulse/PhoneShortlist")<PhoneShortlist, {
  readonly capture: (profileId: string, mode: SelectMode, now: Date) => Effect.Effect<{ readonly html: Uint8Array; readonly metadata: { readonly profile_id: string; readonly jobs: readonly { readonly listing_id: string; readonly summary: ReturnType<typeof starredSummary> }[] } }, SelectResourceError>;
}>() {}

export const PhoneShortlistLive = Layer.effect(PhoneShortlist, Effect.gen(function* () {
  const resource = yield* SavedReviewResource;

  return { capture: (profileId, mode, now) => Effect.gen(function* () {
    const read = yield* resource.read;

    if (!read.verified) return yield* Effect.fail(new SelectResourceError({ message: "Cannot read your reviewed-jobs funnel; capture refused" }));

    const ids = new Set(read.listingIds);
    const candidates = selectShortlist(read.candidates.filter((item) => ids.has(item.listing_id)), read.firstFound, mode);
    const jobs = candidates.filter((item) => !omitted.has(item.lifecycle_status)).map((item) => ({ listing_id: item.listing_id, summary: starredSummary(item) })).sort((a, b) => codepointOrder(a.listing_id, b.listing_id));

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileId) || profileId.length > 64 || jobs.length > 66666 || jobs.some((job, index) => !/^[a-z0-9_-]{1,128}$/.test(job.listing_id) || (index > 0 && jobs[index - 1]?.listing_id === job.listing_id))) return yield* Effect.fail(new SelectResourceError({ message: "Invalid starred metadata" }));

    return { html: renderShortlist(candidates, profileId, mode, read.firstFound, now), metadata: { profile_id: profileId, jobs } };
  }) };
}));
