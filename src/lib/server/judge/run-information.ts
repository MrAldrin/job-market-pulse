import { Context, Effect, Either, Layer, Schema } from "effect";
import { hostname } from "node:os";
import { ReviewerError } from "./reviewer-errors.ts";
import type { Reviewer } from "./reviewers.ts";
import { hangTimeoutSeconds } from "./reviewers.ts";
import { MAX_CANDIDATES_PER_RUN, MAX_MODEL_CALLS_PER_RUN, normalizeListingIds, validateRunLimits } from "./workflow-support.ts";

export class ReviewHost extends Context.Tag("pulse/ReviewHost")<ReviewHost, {
  readonly name: Effect.Effect<string, ReviewerError>;
}>() {}

const hostSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/));
const checkedHost = (value: string) => Schema.decodeUnknownEither(hostSchema)(value).pipe(Either.mapLeft(() => new ReviewerError({ code: "host_unavailable" })));

export const ReviewHostLive = Layer.succeed(ReviewHost, {
  name: Effect.try({ try: hostname, catch: () => new ReviewerError({ code: "host_unavailable" }) }).pipe(Effect.flatMap(checkedHost)),
});

export const reviewerEvent = (reviewer: Reviewer) => ({ id: reviewer.id, harness: reviewer.harness,
  provider: reviewer.provider, model: reviewer.model, effort: reviewer.effort, batch_size: reviewer.batch_size });

export interface RunInformation {
  readonly profileId: string;
  readonly host: string;
  readonly maxOutputTokens: number;
  readonly maxCandidates?: number;
  readonly maxCalls?: number;
  readonly listingIds?: readonly string[] | null;
  readonly readOnlySource?: boolean;
  readonly fullReviewBatchSize: number;
}

/** Informational only. Model configuration is not a per-run consent gate. */
export const disclosureText = (reviewer: Reviewer, options: RunInformation) => Either.gen(function* () {
  const limits = yield* validateRunLimits(options.maxCandidates ?? MAX_CANDIDATES_PER_RUN, options.maxCalls ?? MAX_MODEL_CALLS_PER_RUN);
  const selected = yield* normalizeListingIds(options.listingIds ?? null, limits.maxCandidates);
  const host = yield* checkedHost(options.host);

  if (!Number.isInteger(options.fullReviewBatchSize) || options.fullReviewBatchSize < 1 || options.fullReviewBatchSize > 10) return yield* Either.left(new ReviewerError({ code: "invalid_full_review_batch_size" }));
  const fullAdRequests = 120 + Math.ceil(120 / options.fullReviewBatchSize);
  const source = options.readOnlySource ? "Read-only source checks" : "Bounded NAV source refresh";

  const bounds = options.readOnlySource ? `Up to ${fullAdRequests} full-ad requests. `
    : `Source limits: 30 feed, 10 combined location/address, 30 occupation and ${fullAdRequests} full-ad requests (${70 + fullAdRequests} total). `;

  return `Profile: ${options.profileId}. Calling machine: ${host}.\n`
    + `Configured step: ${reviewer.id}; harness ${reviewer.harness}, provider/model ${reviewer.provider}/${reviewer.model}, effort ${reviewer.effort}.\n`
    + `${source}. ${bounds}Up to ${limits.maxCandidates} candidates and ${limits.maxCalls} model calls per run. Listing selection: ${selected?.join(", ") ?? "dynamic"}.\n`
    + "The model receives private profile text and job data. Job text is untrusted data. Calls have no tools. Prompts and raw replies are not stored. Provider retention and monetary cost are unknown. A subscription is not API access.\n"
    + `Each harness call has a ${hangTimeoutSeconds}-second hang timeout. There is no dollar cap or per-run approval prompt. Pi print does not enforce an output-token cap. Claude Code requests ${options.maxOutputTokens} output tokens. Source, payload, validation and retry bounds still apply. Each call records its step, harness, model, effort, reported tokens and wall time.`;
});
