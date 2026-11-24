import { Either, Option, Schema } from "effect";
import { CandidateManifest, Candidate } from "../../contracts/filter.ts";
import { parseIsoTime } from "../../contracts/iso-time.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { ReviewAssessment, ReviewEnvelope, TitleScreenAssessment, TitleScreenEnvelope } from "../../contracts/fit-review.ts";
import { strip } from "../shared/text.ts";
import { FilterInputError } from "./errors.ts";
import { sourceFreshness } from "./manifest.ts";
import { parseStrictContractBytes, parseStrictContractJson } from "../shared/strict-contract-json.ts";

export type ValidatedAssessment = Candidate & Omit<typeof ReviewAssessment.Type, "version"> & { readonly assessed_at: string };

const invalid = (message: string) => new FilterInputError({ message });

const utcText = (micros: bigint): string => {
  const fraction = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const seconds = (micros - fraction) / 1_000_000n;

  return new Date(Number(seconds) * 1000).toISOString().slice(0, 19) + (fraction ? "." + fraction.toString().padStart(6, "0") : "") + "+00:00";
};

// Raw JSON number tokens must use the encoded side; callers with constructed
// typed values use validateReview directly after the type-side Schema check.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const decodeReview = (raw: unknown) => Either.mapLeft(decodeStrict(ReviewEnvelope)(raw), () => invalid("Unexpected review schema"));
export const decodeReviewJson = (text: string) => Either.flatMap(Either.mapLeft(parseStrictContractJson(text, 2_000_000), () => invalid("Invalid bounded review JSON")), decodeReview);
export const decodeReviewBytes = (bytes: Uint8Array) => Either.flatMap(Either.mapLeft(parseStrictContractBytes(bytes, 2_000_000), () => invalid("Invalid bounded review JSON")), decodeReview);

export const validateReview = (manifest: CandidateManifest, review: ReviewEnvelope, now: bigint, maxAge = 86_400_000_000n): Either.Either<readonly ValidatedAssessment[], FilterInputError> => Either.gen(function* () {
  yield* Either.mapLeft(decodeStrict(Schema.typeSchema(CandidateManifest))(manifest), () => invalid("Invalid candidate manifest"));
  yield* Either.mapLeft(decodeStrict(Schema.typeSchema(ReviewEnvelope))(review), () => invalid("Unexpected review schema"));
  yield* sourceFreshness(manifest.checked_at, manifest.caught_up ? "1" : "0", now, maxAge);

  if (review.profile_id !== manifest.profile_id || review.manifest_id !== manifest.manifest_id) return yield* Either.left(invalid("Review does not match current profile and source manifest"));

  const assessed = parseIsoTime(review.assessed_at);
  const checked = parseIsoTime(manifest.checked_at);

  if (Option.isNone(assessed) || !assessed.value.aware || Option.isNone(checked)) return yield* Either.left(invalid("Assessment must include timezone"));

  if (assessed.value.epochMicros > now || assessed.value.epochMicros < checked.value.epochMicros) return yield* Either.left(invalid("Assessment must follow source check and not be in future"));

  const originals = new Map(manifest.candidates.map((item) => [item.id, item]));

  if (review.assessments.length !== originals.size) return yield* Either.left(invalid("Missing or extra candidate assessments"));

  const seen = new Set<string>();
  const result: ValidatedAssessment[] = [];

  for (const row of review.assessments) {
    const source = originals.get(row.id);

    if (source === undefined || seen.has(row.id)) return yield* Either.left(invalid("Unknown or repeated candidate identity"));
    seen.add(row.id);

    if (source.expires_at !== null) {
      const expiry = parseIsoTime(source.expires_at);

      if (Option.isNone(expiry) || !expiry.value.aware) return yield* Either.left(invalid("Invalid expiry"));

      if (expiry.value.epochMicros <= now) return yield* Either.left(invalid("Candidate expired; rebuild the current source manifest"));
    }

    if ((row.fit === "exceptional" || row.fit === "strong") && (!row.ad_text_reviewed || row.evidence.length === 0 || source.detail_missing)) return yield* Either.left(invalid("Strong/exceptional fit requires reviewed ad text and source details"));

    if (row.fit === "exceptional" && (row.uncertainties.length > 0 || row.hard_constraints !== "pass")) return yield* Either.left(invalid("Exceptional fit requires passed hard constraints and no unresolved uncertainty"));

    const { version: _echo, ...assertion } = row;
    result.push({ ...source, ...assertion, version: source.version, assessed_at: utcText(assessed.value.epochMicros) });
  }

  return result;
});

// Generated IN-PROCESS objects only: schema_version is typed number 1, not
// encoded bigint 1n. Never use this for provider/raw/stored JSON: its lexical
// integer identity must be checked by the existing JSON decoding path.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const validateGeneratedReviewObject = (manifest: CandidateManifest, raw: unknown, now: bigint, maxAge = 86_400_000_000n): Either.Either<readonly ValidatedAssessment[], FilterInputError> => Either.flatMap(
  Either.mapLeft(decodeStrict(Schema.typeSchema(ReviewEnvelope))(raw), () => invalid("Unexpected review schema")),
  (review) => validateReview(manifest, review, now, maxAge),
);

export type ValidatedTitleScreenAssessment = Omit<typeof TitleScreenAssessment.Type, "version"> & { readonly version: string; readonly assessed_at: string };

export const validateTitleScreen = (manifest: CandidateManifest, screen: TitleScreenEnvelope, now: bigint, maxAge = 86_400_000_000n): Either.Either<readonly ValidatedTitleScreenAssessment[], FilterInputError> => Either.gen(function* () {
  yield* Either.mapLeft(decodeStrict(Schema.typeSchema(CandidateManifest))(manifest), () => invalid("Invalid candidate manifest"));
  yield* Either.mapLeft(decodeStrict(Schema.typeSchema(TitleScreenEnvelope))(screen), () => invalid("Unexpected title-screen schema"));
  yield* sourceFreshness(manifest.checked_at, manifest.caught_up ? "1" : "0", now, maxAge);

  if (screen.profile_id !== manifest.profile_id || screen.manifest_id !== manifest.manifest_id) return yield* Either.left(invalid("Screening does not match current profile and manifest"));

  const assessed = parseIsoTime(screen.assessed_at);
  const checked = parseIsoTime(manifest.checked_at);

  if (Option.isNone(assessed) || !assessed.value.aware || Option.isNone(checked)) return yield* Either.left(invalid("Assessment must include timezone"));

  if (assessed.value.epochMicros > now || assessed.value.epochMicros < checked.value.epochMicros) return yield* Either.left(invalid("Screening must follow source check and not be in future"));

  const originals = new Map(manifest.candidates.map((item) => [item.id, item]));

  if (screen.assessments.length !== originals.size) return yield* Either.left(invalid("Missing or extra title-screen assessments"));

  const seen = new Set<string>();
  const result: ValidatedTitleScreenAssessment[] = [];

  for (const row of screen.assessments) {
    const candidate = originals.get(row.id);

    if (candidate === undefined || seen.has(row.id)) return yield* Either.left(invalid("Unknown or repeated title-screen candidate"));
    seen.add(row.id);

    if (candidate.expires_at !== null) {
      const expiry = parseIsoTime(candidate.expires_at);

      if (Option.isNone(expiry) || !expiry.value.aware) return yield* Either.left(invalid("Invalid expiry"));

      if (expiry.value.epochMicros <= now) return yield* Either.left(invalid("Candidate expired; rebuild the current source manifest"));
    }

    result.push({ id: row.id, version: candidate.version, outcome: row.outcome, reason: strip(row.reason), assessed_at: utcText(assessed.value.epochMicros) });
  }

  return result;
});

// Ordinary stage replies retain encoded JSON integer identity. Judge calls this
// decoder at its frozen validation point, then the canonical title validator.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const decodeTitleScreen = (raw: unknown) => Either.mapLeft(decodeStrict(TitleScreenEnvelope)(raw), () => invalid("Unexpected title-screen schema"));

export const reviewTemplate = (manifest: CandidateManifest) => ({
  schema_version: 1, profile_id: manifest.profile_id, manifest_id: manifest.manifest_id,
  assessed_at: "REPLACE_WITH_AWARE_TIMESTAMP_AFTER_REVIEW", complete: false,
  assessments: manifest.candidates.map((item) => ({
    id: item.id, version: item.version, fit: "unknown", reason: "Not assessed", evidence: [],
    uncertainties: ["Not reviewed"], hard_constraints: "unknown", ad_text_reviewed: false,
  })),
});
