import { Either, Predicate, Schema } from "effect";
import { DigestInstant, DigestRequest, type Digest } from "../../contracts/select.ts";
import { decodeStrict } from "../../contracts/support.ts";
import type { JsonInput } from "../shared/json-input.ts";
import { parseStrictContractBytes, parseStrictContractJson } from "../shared/strict-contract-json.ts";
import { DigestInputError } from "./errors.ts";

const invalid = () => new DigestInputError({ message: "Invalid digest input" });
export const parseRequest = (value: JsonInput) => Either.mapLeft(decodeStrict(DigestRequest)(value), invalid);
export const validateTypedRequest = (value: DigestRequest) => Either.mapLeft(decodeStrict(Schema.typeSchema(DigestRequest))(value), invalid);

export const parseRequestJson = (text: string) => Either.flatMap(Either.mapLeft(parseStrictContractJson(text, 1_048_576), invalid), parseRequest);
export const parseRequestBytes = (bytes: Uint8Array) => Either.flatMap(Either.mapLeft(parseStrictContractBytes(bytes, 1_048_576), invalid), parseRequest);

export interface DigestOptions {
  readonly maxAgeMicros?: bigint;
  readonly maxCount?: number;
}

export const selectDigest = (input: DigestRequest, asOf: bigint, options: DigestOptions = {}): Either.Either<Digest, DigestInputError> =>
  Either.flatMap(validateTypedRequest(input), (request) => {
    const maxAge = options.maxAgeMicros ?? 604800000000n;
    const limit = options.maxCount ?? 120;

    if (Either.isLeft(decodeStrict(DigestInstant)(asOf)) || !Predicate.isBigInt(maxAge) || maxAge <= 0n
      || !Number.isInteger(limit) || limit < 0 || limit > 120) return Either.left(new DigestInputError({ message: "Invalid digest selection options" }));
    const blockers: string[] = [];

    if (!request.assessments_complete) blockers.push("assessments_incomplete");

    if (!request.snapshot.caught_up) blockers.push("source_not_caught_up");
    const sourceAge = asOf - request.snapshot.checked_at;

    if (sourceAge < 0n) blockers.push("source_timestamp_in_future");
    else if (sourceAge > maxAge) blockers.push("source_stale");
    const eligible: DigestRequest["candidates"][number][] = [];

    if (!blockers.length) {
      for (const candidate of request.candidates) {
        if (request.delivered.some(({ id, version }) => id === candidate.id && version === candidate.version)) continue;

        if (candidate.expires_at === null) { blockers.push("candidate_expiry_unknown"); continue; }

        if (candidate.expires_at <= asOf) continue;
        const statuses = Object.values(candidate.hard_constraints);

        if (statuses.includes("fail")) continue;

        if (statuses.includes("unknown")) { blockers.push("hard_constraint_unknown"); continue; }

        if (candidate.assessed_at > asOf) { blockers.push("assessment_timestamp_in_future"); continue; }

        if (candidate.assessed_at < request.snapshot.checked_at) { blockers.push("assessment_predates_snapshot"); continue; }

        if (asOf - candidate.assessed_at > maxAge) { blockers.push("assessment_stale"); continue; }

        if (candidate.fit === "unknown") { blockers.push("fit_assessment_unknown"); continue; }

        eligible.push(candidate);
      }
    }

    const candidates = blockers.length ? [] : eligible.filter((candidate) => candidate.fit === "exceptional" || (request.mode === "active" && candidate.fit === "strong")).slice(0, limit);
    const market = !blockers.length && (candidates.length > 0 || request.include_market_only) ? request.market_context : null;

    return Either.right({ profile_id: request.profile_id, profile_fingerprint: request.profile_fingerprint, pack: request.pack,
      as_of: asOf, status: blockers.length ? "blocked" : candidates.length || market !== null ? "ready" : "quiet",
      blocked_reasons: [...new Set(blockers)], candidates, market_context: market });
  });
