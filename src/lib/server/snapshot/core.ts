import { Either, Option, Schema } from "effect";
import { Snapshot } from "../../contracts/snapshot.ts";
import { isoEpochMillis, parseIsoTime } from "../../contracts/iso-time.ts";
import { marketSection, reviewedTrendSection } from "../market/trends.ts";
import { readSalaryRows, salarySection } from "../market/salary-view.ts";
import { selectShortlist, shortlistRule } from "../select/shortlist-select.ts";
import type { SnapshotCandidate, SnapshotInputs } from "./inputs.ts";
import { SnapshotError } from "./errors.ts";

const coverageNote = "Bounded NAV change-feed pool; excludes FINN-sourced ads.";

const job = (candidate: SnapshotCandidate, status: "open" | "closed", firstFound: Readonly<Record<string, string>>) => {
  const review = candidate.full_review;
  const found = firstFound[candidate.listing_id] ?? null;

  // This is display text, not a change to the stored assessment or snapshot wire format.
  const reason = review !== null && candidate.older_review
    ? Array.from(`Made with an older profile or prompt. ${review.reason}`).slice(0, 1000).join("")
    : review?.reason;

  return {
    id: candidate.listing_id, source: "nav" as const, source_version: candidate.source_version,
    title: candidate.title, employer: candidate.employer, locations: [...candidate.locations],
    url: candidate.url, expires_at: candidate.expires_at, status,
    first_found_at: found, reviewed_at: found, result_id: candidate.full_review_result_id,
    assessment: review === null ? {
      fit: "unknown", reason: "No saved full review is available.", evidence: [], uncertainties: [],
      hard_constraints: "unknown", ad_text_reviewed: false,
    } : {
      fit: review.fit, reason: reason ?? review.reason, evidence: [...review.evidence], uncertainties: [...review.uncertainties],
      hard_constraints: review.hard_constraints, ad_text_reviewed: review.ad_text_reviewed,
    },
  };
};

export const buildSnapshot = (input: SnapshotInputs): Either.Either<Snapshot, SnapshotError> => {
  const parsed = parseIsoTime(input.now);

  if (Option.isNone(parsed) || !parsed.value.aware) return Either.left(new SnapshotError({ message: "Snapshot time must include a timezone" }));

  if (!input.funnel.verified) return Either.left(new SnapshotError({ message: "Cannot read your reviewed-jobs funnel" }));
  const date = new Date(isoEpochMillis(parsed.value));
  const micros = ((parsed.value.epochMicros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const generated = date.toISOString().slice(0, 19) + (micros === 0n ? "" : `.${micros.toString().padStart(6, "0")}`) + "+00:00";
  const today = date.toISOString().slice(0, 10);
  const { judge, market } = input;
  const opened = judge.ranked.filter((item) => input.funnel.listingIds.has(item.listing_id));
  const closed = judge.closed.filter((item) => input.funnel.listingIds.has(item.listing_id));
  const jobs = [...opened.map((item) => job(item, "open", judge.firstFound)), ...closed.map((item) => job(item, "closed", judge.firstFound))];
  const ids = new Set([...opened, ...closed].map((item) => item.listing_id));

  return Either.map(marketSection(market.snapshots, market.taxonomy, today), (section) => ({
    schema: "pulse.snapshot" as const, schema_version: 1 as const, generated_at: generated,
    profile: input.profile, source: { name: "nav" as const, checked_at: judge.checked_at, coverage_note: coverageNote },
    counts: { eligible: judge.eligible_count, reviewed: jobs.length, open: opened.length, closed: closed.length,
      pending: judge.pending_count, screened_out: judge.screened_out_count, failed: judge.failed_count },
    jobs, shortlist: { job_ids: selectShortlist(opened, judge.firstFound, input.profile.mode).map((item) => item.listing_id), rule: shortlistRule(input.profile.mode) },
    market: section, reviewed_trend: reviewedTrendSection(market.ads, ids, market.taxonomy, today),
    salary: salarySection(readSalaryRows(market.salaries, ids)),
  })).pipe(
    Either.flatMap(Schema.decodeUnknownEither(Schema.typeSchema(Snapshot), { onExcessProperty: "error" })),
    Either.mapLeft(() => new SnapshotError({ message: "Cannot build a valid snapshot" })),
  );
};
