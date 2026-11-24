import { Either, Schema } from "effect";
import { LocalNarrativeUpdate, type LocalSettingsDocument } from "../../contracts/local-settings.ts";
import { maxSuggestionEvidence, suggestionLine, type SettingsSuggestionResult } from "../../contracts/settings-suggestions.ts";
import type { SnapshotDocument } from "../../contracts/snapshot.ts";
import { boundedInteger, decodeStrict } from "../../contracts/support.ts";
import { matchesTerm } from "../filter/title-evidence.ts";
import { checkNarrative } from "../profile/narrative.ts";
import { normalized } from "../shared/text.ts";
import { parseStrictContractJson } from "../shared/strict-contract-json.ts";

type Job = SnapshotDocument["jobs"][number];

type Result<H> = Extract<SettingsSuggestionResult, { helper: H }>;

type ProfileProposal = NonNullable<Result<"profile_from_feedback">["proposal"]>;

type TitleProposal = NonNullable<Result<"title_exclusion">["proposal"]>;

type FeedbackEvidence = ProfileProposal["evidence"][number];

export const isPoor = (job: Job): boolean => job.assessment.fit === "poor" && job.assessment.ad_text_reviewed;

const reason = suggestionLine(600);
const textValue = Schema.is(suggestionLine(300));

const profileReply = decodeStrict(Schema.NullOr(Schema.Struct({
  reason, text: LocalNarrativeUpdate.fields.values,
  job_ids: Schema.Array(Schema.String).pipe(Schema.minItems(1), Schema.maxItems(maxSuggestionEvidence)),
})));

const titleReply = decodeStrict(Schema.NullOr(Schema.Struct({ reason, term: suggestionLine(120) })));

const decodeReply = (text: string) => text.trim() === "null" ? Either.right(null) : parseStrictContractJson(text, 128 * 1024);

export function feedbackEvidence(jobs: readonly Job[], reactions: ReadonlyMap<string, "up" | "down">): readonly FeedbackEvidence[] {
  const liked: FeedbackEvidence[] = [];
  const disliked: FeedbackEvidence[] = [];

  for (const job of jobs) {
    if (!textValue(job.title)) continue;
    const reaction = reactions.get(job.id);

    if (reaction === "up") liked.push({ job_id: job.id, title: job.title, signal: "liked" });

    if (reaction === "down") disliked.push({ job_id: job.id, title: job.title, signal: "disliked" });
  }

  return [...liked.slice(0, maxSuggestionEvidence / 2), ...disliked.slice(0, maxSuggestionEvidence / 2)];
}

export const poorTitleSample = (jobs: readonly Job[]) => jobs.filter((job) => isPoor(job) && textValue(job.title)).slice(0, maxSuggestionEvidence);

export function profileProposal(text: string, base: { readonly text: string; readonly revision: string }, sent: readonly FeedbackEvidence[]) {
  return Either.flatMap(Either.flatMap(decodeReply(text), profileReply), (reply): Either.Either<ProfileProposal | null, string> => {
    if (!reply || reply.text === base.text) return Either.right(null);
    const cited = new Set(reply.job_ids);
    const evidence = sent.filter((item) => cited.has(item.job_id));

    if (evidence.length !== reply.job_ids.length || checkNarrative(reply.text, { requireTemplate: false }).length) return Either.left("invalid proposal");

    return Either.right({ reason: reply.reason, evidence, change: { kind: "narrative", revision: base.revision, values: reply.text } });
  });
}

export function titleProposal(text: string, base: { readonly excluded_title_terms: readonly string[]; readonly revision: string }, jobs: readonly Job[], sent: readonly Job[]) {
  return Either.map(Either.flatMap(decodeReply(text), titleReply), (reply): TitleProposal | null => {
    if (!reply || !/[\p{L}\p{N}]/u.test(reply.term)) return null;
    const { term } = reply;
    const supports = sent.filter((job) => matchesTerm(term, job.title) && !base.excluded_title_terms.some((existing) => matchesTerm(existing, job.title)));

    if (supports.length < 2 || jobs.some((job) => matchesTerm(term, job.title) && !isPoor(job))) return null;

    return {
      term, reason: reply.reason, evidence: supports.map(({ id, title }) => ({ job_id: id, title, signal: "poor" })),
      change: { kind: "excluded_title_terms", revision: base.revision, values: [...base.excluded_title_terms, term] },
    };
  });
}

const candidateReply = decodeStrict(Schema.NullOr(Schema.Struct({ candidate: boundedInteger(0, maxSuggestionEvidence - 1) })));

type Filters = LocalSettingsDocument["filters"];

const employerKey = normalized; // Same normalized equality as Filter assessment.
const evidenceFor = ({ id, title }: Job, signal: FeedbackEvidence["signal"]): FeedbackEvidence => ({ job_id: id, title, signal });

export function employerCandidates(base: Filters, jobs: readonly Job[], reactions: ReadonlyMap<string, "up" | "down"> | null) {
  const candidates: NonNullable<Result<"employer_exclusion">["proposal"]>[] = [];

  if (!reactions) return candidates;
  const groups = Map.groupBy(jobs, (job) => employerKey(job.employer));
  const existing = new Set(base.excluded_employers.map(employerKey));

  for (const [key, group] of groups) {
    if (!key || existing.has(key) || group.some((job) => !isPoor(job) || reactions.get(job.id) === "up")) continue;
    const employer = group.find((job) => textValue(job.employer))?.employer;
    const sample = group.filter((job) => textValue(job.title)).slice(0, 2);

    if (!employer || sample.length < 2) continue;
    candidates.push({ employer, evidence: sample.map((job) => evidenceFor(job, "poor")),
      reason: "At least two reviewed jobs from this employer had poor fit. No saved job from this employer had a different fit, lacked ad review or had a like.",
      change: employerChange(base, [...base.excluded_employers, employer]),
    });

    if (candidates.length === maxSuggestionEvidence / 2) break;
  }

  return candidates;
}

function employerChange(base: Filters, excluded_employers: readonly string[]) {
  const { revision, excluded_municipalities, allowed_occupation_categories } = base;

  return { kind: "filters" as const, revision, values: { excluded_municipalities, allowed_occupation_categories, excluded_employers } };
}

const isLiked = (job: Job, reactions: ReadonlyMap<string, "up" | "down">) => reactions.get(job.id) === "up" && textValue(job.title);

export const likedTitleSample = (jobs: readonly Job[], reactions: ReadonlyMap<string, "up" | "down">) =>
  jobs.filter((job) => isLiked(job, reactions)).slice(0, maxSuggestionEvidence);

export function preferredProposal(text: string, base: NonNullable<LocalSettingsDocument["judge"]>, sent: readonly Job[]) {
  return Either.map(Either.flatMap(decodeReply(text), titleReply), (reply): NonNullable<Result<"preferred_term">["proposal"]> | null => {
    if (!reply || !/[\p{L}\p{N}]/u.test(reply.term) || base.preferred_terms.some((term) => matchesTerm(term, reply.term))) return null;
    const evidence = sent.flatMap((job) => matchesTerm(reply.term, job.title) ? [evidenceFor(job, "liked")] : []);

    if (!evidence.length) return null;

    return { ...reply, evidence, change: { kind: "judge", revision: base.revision, values: [...base.preferred_terms, reply.term] } };
  });
}

export function removalCandidates(base: Filters, jobs: readonly Job[], reactions: ReadonlyMap<string, "up" | "down">) {
  const liked = jobs.filter((job) => isLiked(job, reactions));
  const candidates: NonNullable<Result<"remove_exclusion">["proposal"]>[] = [];
  const reason = "This current rule matches a liked saved job. This check does not show whether the rule blocked that job in the past or whether another rule still excludes it.";

  for (const kind of ["excluded_title_terms", "excluded_employers"] as const) {
    const values = base[kind];

    for (const rule of new Set(values)) {
      if (!textValue(rule)) continue;
      const match = liked.find((job) => kind === "excluded_title_terms" ? matchesTerm(rule, job.title) : employerKey(rule) === employerKey(job.employer));

      if (!match) continue;
      const remaining = values.filter((value) => value !== rule);
      const change = kind === "excluded_title_terms" ? { kind, revision: base.revision, values: remaining } : employerChange(base, remaining);
      candidates.push({ rule, reason, evidence: [evidenceFor(match, "liked")], change });

      if (candidates.length === maxSuggestionEvidence) return candidates;
    }
  }

  return candidates;
}

export function selectCandidate<A>(text: string, candidates: readonly A[]) {
  return Either.flatMap(Either.flatMap(decodeReply(text), candidateReply), (reply) => {
    if (reply === null) return Either.right(null);
    const candidate = candidates[reply.candidate];

    return candidate === undefined ? Either.left("unknown candidate") : Either.right(candidate);
  });
}
