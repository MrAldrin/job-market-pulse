import { Effect, Either, Predicate, Schema } from "effect";
import { Digest, ReviewStage, type StageInput } from "../../contracts/judge-state.ts";
import { pythonJson } from "../shared/python-json.ts";
import { candidateJson } from "../filter/manifest.ts";
import { validateManifestContext } from "./attempts.ts";
import { STAGE_PROMPT_VERSIONS } from "./prompts.ts";
import { validateCurrentManifest } from "./batches.ts";
import { historicalResult, matchesReviewMaterial, olderReviewContext, savedResultContext, type HistoricalResult } from "./history-context.ts";
import { fingerprint, instant, normalizeIdentity, REJUDGE_STAGE_VERSION } from "./core.ts";
import { JudgeStateError } from "./errors.ts";
import { stageInputFingerprint, type CandidateProjection, type ManifestProjection } from "./inputs.ts";
import { parseSnapshotProvenance, snapshotBindingId, validateSnapshotAdmission } from "./provenance.ts";
import { readRun, runCandidates } from "./runs.ts";
import { decodeStored, requireInitialized, sqlError, write, type JudgeSession } from "./session.ts";
import { ResultRow, decodeResult, jsonProperty, parseStoredJson, type StoredStageResult } from "./stored.ts";

const ProvenanceResultRow = Schema.Struct({ ...ResultRow.fields, snapshot_provenance_json: Schema.NullOr(Schema.String) });

const SavedBindingRow = Schema.Struct({
  ...ProvenanceResultRow.fields,
  source_text_fingerprint: Schema.NullOr(Schema.String),
  attempt_upstream_result_id: Schema.NullOr(Schema.String),
});

const AttachmentRow = Schema.Struct({ ...SavedBindingRow.fields, attempt_profile_id: Schema.String });

export const provenanceColumn = (session: JudgeSession) => Effect.gen(function* () {
  const columns = yield* session.sql<{ name: string }>`PRAGMA table_info(stage_attempt_candidates)`;

  return columns.some((column) => column.name === "snapshot_provenance_json") ? "c.snapshot_provenance_json" : "NULL";
});

export const savedReviewForCandidate = (
  session: JudgeSession, manifest: ManifestProjection, candidate: CandidateProjection, stage: ReviewStage,
  prompt: string, upstream: string | null, text: string | null,
) => Effect.gen(function* () {
  const column = yield* provenanceColumn(session);

  const rows = yield* session.sql.unsafe(`SELECT r.*,c.source_text_fingerprint,c.upstream_result_id AS attempt_upstream_result_id,${column} AS snapshot_provenance_json
    FROM stage_results r JOIN stage_attempts a ON a.attempt_id=r.attempt_id
    JOIN stage_attempt_candidates c ON c.attempt_id=r.attempt_id AND c.listing_id=r.listing_id
    WHERE a.profile_id=? AND a.status='completed' AND r.listing_id=? AND r.stage=?
    AND r.stage_version<>? AND (?='title_screen' OR (r.source_version=? AND r.upstream_result_id=?)) ORDER BY r.recorded_at DESC,r.rowid DESC`,
  [session.profile_id, candidate.id, stage, REJUDGE_STAGE_VERSION, stage, candidate.version, upstream]);

  for (const raw of rows) {
    const { snapshot_provenance_json, source_text_fingerprint, attempt_upstream_result_id, ...row } = yield* decodeStored(SavedBindingRow, raw);

    if (stage === "full_review" && (row.upstream_result_id !== attempt_upstream_result_id || (text !== null && source_text_fingerprint !== text))) continue;

    const parsed = parseSnapshotProvenance(snapshot_provenance_json);

    if (Either.isLeft(parsed) || (parsed.right?.refresh && parsed.right.format_version !== 1)) continue;
    const binding = snapshotBindingId(snapshot_provenance_json, candidate.version);

    if (Either.isLeft(binding)) continue;
    const context = yield* savedResultContext(session, row.result_id);

    if (!matchesReviewMaterial(row, context, manifest, candidate, source_text_fingerprint, binding.right)) continue;

    return { result: yield* decodeResult(row), older: olderReviewContext(row, context, manifest, prompt),
      expiry: parsed.right?.format_version === 1 ? parsed.right.expires_at : undefined };
  }

  return null;
}).pipe(Effect.mapError(sqlError));

export interface SavedResultOptions {
  readonly current_manifest?: ManifestProjection;
  readonly now?: bigint;
  readonly max_age_micros?: bigint;
  readonly source_text_fingerprints?: ReadonlyMap<string, string>;
  readonly prompt_versions?: ReadonlyMap<string, string>;
}

export const getSavedResult = (session: JudgeSession, resultId: string, options: SavedResultOptions = {}): Effect.Effect<StoredStageResult | HistoricalResult | null, JudgeStateError> => Effect.gen(function* () {
  if (!session.initialized) return null;

  const selected = yield* normalizeIdentity(resultId);
  const provenance = yield* provenanceColumn(session);
  const rows = yield* session.sql.unsafe(`SELECT s.*,c.source_text_fingerprint,${provenance} AS snapshot_provenance_json,c.upstream_result_id AS attempt_upstream_result_id FROM stage_results s JOIN stage_attempt_candidates c ON c.attempt_id=s.attempt_id AND c.listing_id=s.listing_id JOIN stage_attempts a ON a.attempt_id=s.attempt_id WHERE s.result_id=? AND a.profile_id=?`, [selected, session.profile_id]);

  if (!rows[0]) return yield* historicalResult(session, selected);

  const { snapshot_provenance_json, source_text_fingerprint, attempt_upstream_result_id, ...saved } = yield* decodeStored(SavedBindingRow, rows[0]);
  const result = yield* decodeResult(saved);
  const now = options.now;

  if (now !== undefined && result.stage === "full_review") {
    const parsed = parseSnapshotProvenance(snapshot_provenance_json);

    if (Either.isLeft(parsed)) return result;

    if (parsed.right !== null && ((parsed.right.refresh !== null && parsed.right.format_version !== 1) || (parsed.right.format_version === 1 && parsed.right.expires_at !== null && (yield* instant(parsed.right.expires_at)) <= now))) return result;
  }

  const current = options.current_manifest;

  if (current === undefined || now === undefined) return result;

  const maxAge = options.max_age_micros ?? 86_400_000_000n;

  // Saved-result reads explicitly require a positive maximum age. The frozen
  // private commit helper has a separate zero-age equality rule; do not change it.
  if (maxAge <= 0n) return result;

  const admission = yield* Effect.either(validateCurrentManifest(session.profile_id, result, current, now, maxAge));

  if (Either.isLeft(admission)) return result;

  const candidate = current.candidates.find((candidate) => candidate.id === result.listing_id);

  if (!candidate) return result;

  if (source_text_fingerprint !== null && options.source_text_fingerprints?.get(result.listing_id) !== source_text_fingerprint) return result;

  if (source_text_fingerprint === null && candidate.version !== result.source_version) return result;

  const prompt = options.prompt_versions?.size ? options.prompt_versions.get(result.stage) : STAGE_PROMPT_VERSIONS[result.stage];

  if (prompt !== result.prompt_version) return result;

  if (result.stage === "full_review") {
    const screenPrompt = options.prompt_versions?.size ? options.prompt_versions.get("title_screen") : STAGE_PROMPT_VERSIONS.title_screen;

    if (screenPrompt === undefined) return result;

    const screenFingerprint = stageInputFingerprint(current, candidate, "title_screen", screenPrompt);

    if (Either.isLeft(screenFingerprint)) return result;

    // SQL failures remain failures. Only private read-value/contract failures
    // become stale output, as in the frozen saved-result read path.
    const screens = yield* session.sql`SELECT result_id,result_json FROM stage_results WHERE listing_id=${result.listing_id} AND stage='title_screen' AND input_fingerprint=${screenFingerprint.right} ORDER BY recorded_at DESC,rowid DESC LIMIT 1`;

    if (!screens[0]) return result;

    const screen = decodeStored(Schema.Struct({ result_id: Schema.String, result_json: Schema.String }), screens[0]);

    if (Either.isLeft(screen) || screen.right.result_id !== attempt_upstream_result_id) return result;

    const value = parseStoredJson(screen.right.result_json);

    if (Either.isLeft(value) || jsonProperty(value.right, "outcome") !== "advance_to_full_review") return result;
  }

  const binding = snapshotBindingId(snapshot_provenance_json, candidate.version);

  if (Either.isLeft(binding) || prompt === undefined) return result;

  const currentFingerprint = stageInputFingerprint(current, candidate, result.stage, prompt, source_text_fingerprint, binding.right, attempt_upstream_result_id);

  return Either.isLeft(currentFingerprint) ? result : { ...result, stale: currentFingerprint.right !== result.input_fingerprint };
}).pipe(Effect.mapError(sqlError));

export const reusableResult = (session: JudgeSession, stage: ReviewStage, listingId: string, inputFingerprint: string, now?: bigint) => Effect.gen(function* () {
  yield* requireInitialized(session);
  yield* decodeStored(ReviewStage, stage);
  const identity = yield* normalizeIdentity(listingId);
  const expected = yield* decodeStored(Digest, inputFingerprint);
  const provenance = yield* provenanceColumn(session);
  const rows = yield* session.sql.unsafe(`SELECT r.*,${provenance} AS snapshot_provenance_json FROM stage_results r JOIN stage_attempt_candidates c ON c.attempt_id=r.attempt_id AND c.listing_id=r.listing_id WHERE r.listing_id=? AND r.stage=? AND r.input_fingerprint=? ORDER BY r.recorded_at DESC,r.rowid DESC LIMIT 1`, [identity, stage, expected]);

  if (!rows[0]) return null;

  const { snapshot_provenance_json, ...row } = yield* decodeStored(ProvenanceResultRow, rows[0]);

  if (stage === "full_review") {
    const parsed = parseSnapshotProvenance(snapshot_provenance_json);

    if (Either.isLeft(parsed)) return null;

    if (parsed.right !== null) {
      if (parsed.right.refresh !== null && parsed.right.format_version !== 1) return null;

      if (parsed.right.format_version === 1 && parsed.right.expires_at !== null && (now === undefined || (yield* instant(parsed.right.expires_at)) <= now)) return null;
    }
  }

  return yield* decodeResult(row);
}).pipe(Effect.mapError(sqlError));

export interface AttachReusedOptions {
  readonly listing_id: string;
  readonly result_id: string;
  readonly expected_input_fingerprint: string;
  readonly now?: bigint;
  readonly current_manifest?: ManifestProjection;
  readonly current_source_text_fingerprints?: ReadonlyMap<string, string>;
  readonly reuse_screen_material?: boolean;
  readonly max_age_micros?: bigint;
}

export const attachReusedResult = (session: JudgeSession, runId: string, options: AttachReusedOptions) => Effect.gen(function* () {
  yield* requireInitialized(session);
  const selectedRun = yield* normalizeIdentity(runId);
  const identity = yield* normalizeIdentity(options.listing_id);
  const selectedResult = yield* normalizeIdentity(options.result_id);
  const expected = yield* decodeStored(Digest, options.expected_input_fingerprint);

  return yield* write(session, Effect.gen(function* () {
    const provenance = yield* provenanceColumn(session);
    const rows = yield* session.sql.unsafe(`SELECT s.*,a.profile_id AS attempt_profile_id,c.source_text_fingerprint,c.upstream_result_id AS attempt_upstream_result_id,${provenance} AS snapshot_provenance_json FROM stage_results s JOIN stage_attempts a ON a.attempt_id=s.attempt_id JOIN stage_attempt_candidates c ON c.attempt_id=s.attempt_id AND c.listing_id=s.listing_id WHERE s.result_id=? AND s.listing_id=? AND s.input_fingerprint=?`, [selectedResult, identity, expected]);

    if (!rows[0]) return yield* new JudgeStateError({ message: "No reusable stage result matches the current input" });

    const { snapshot_provenance_json, attempt_profile_id, source_text_fingerprint, attempt_upstream_result_id, ...saved } = yield* decodeStored(AttachmentRow, rows[0]);
    const result = yield* decodeResult(saved);

    if (result.stage === "full_review") {
      const parsed = yield* parseSnapshotProvenance(snapshot_provenance_json);

      if (parsed !== null) {
        if (parsed.refresh !== null && parsed.format_version !== 1) return yield* new JudgeStateError({ message: "Refreshed result has no durable expiry" });

        if (parsed.format_version === 1 && parsed.expires_at !== null && (options.now === undefined || (yield* instant(parsed.expires_at)) <= options.now)) {
          return yield* new JudgeStateError({ message: "Reviewed result is expired" });
        }
      }
    }

    const run = yield* readRun(session, selectedRun);

    if (run.status !== "running" && run.status !== "partial") return yield* new JudgeStateError({ message: "Run is not open for reused results" });

    const reuseScreen = options.reuse_screen_material === true && result.stage === "title_screen" && options.current_manifest !== undefined;

    if (!reuseScreen && (result.profile_fingerprint !== run.context.profile_fingerprint || result.preferences_fingerprint !== run.context.preferences_fingerprint || result.rules_fingerprint !== run.context.rules_fingerprint || result.scoring_version !== run.context.scoring_version)) {
      return yield* new JudgeStateError({ message: "Reusable result belongs to different personal inputs" });
    }

    const candidateRun = (yield* runCandidates(session, run.run_id)).find((candidate) => candidate.listing_id === identity);

    if (!candidateRun) return yield* new JudgeStateError({ message: "Reusable result candidate is not in this run" });

    const current = options.current_manifest;

    if (current !== undefined) {
      const now = options.now;

      if (now === undefined) return yield* new JudgeStateError({ message: "Current manifest validation requires an explicit time" });

      if (attempt_profile_id !== session.profile_id) return yield* new JudgeStateError({ message: "Reusable result belongs to another profile" });

      yield* validateManifestContext(session, current, run.context);
      yield* validateCurrentManifest(session.profile_id, reuseScreen ? run.context : result, current, now, options.max_age_micros ?? 86_400_000_000n);
      const matches = current.candidates.filter((candidate) => candidate.id === result.listing_id);
      const candidate = matches[0];

      if (matches.length !== 1 || !candidate) return yield* new JudgeStateError({ message: "Reusable result is not in the current manifest" });

      if (candidateRun.source_version !== candidate.version || candidateRun.candidate_fingerprint !== fingerprint(candidateJson(candidate))) {
        return yield* new JudgeStateError({ message: "Current candidate differs from the saved run snapshot" });
      }

      if (candidate.expires_at !== null && (yield* instant(candidate.expires_at)) <= now) return yield* new JudgeStateError({ message: "Current candidate is expired" });

      if (source_text_fingerprint !== null) {
        if (options.current_source_text_fingerprints?.get(result.listing_id) !== source_text_fingerprint) return yield* new JudgeStateError({ message: "Current ad-text fingerprint changed" });
      } else if (!reuseScreen && candidate.version !== result.source_version) return yield* new JudgeStateError({ message: "Current source identity changed" });

      let snapshot: string | null = null;

      if (result.stage === "full_review") {
        if (attempt_upstream_result_id !== result.upstream_result_id) return yield* new JudgeStateError({ message: "Saved full-review provenance is invalid" });

        const parsed = yield* parseSnapshotProvenance(snapshot_provenance_json);

        if (parsed !== null) {
          if (parsed.refresh !== null && parsed.format_version !== 1) return yield* new JudgeStateError({ message: "Refreshed result has no durable expiry" });

          yield* validateSnapshotAdmission(parsed, result.source_version, candidate.expires_at);

          if (parsed.format_version === 1 && parsed.expires_at !== null && (yield* instant(parsed.expires_at)) <= now) return yield* new JudgeStateError({ message: "Reviewed result is expired" });
        }

        snapshot = yield* snapshotBindingId(snapshot_provenance_json, candidate.version);
      }

      const prompt = STAGE_PROMPT_VERSIONS[result.stage];
      const currentFingerprint = yield* stageInputFingerprint(current, candidate, result.stage, prompt, source_text_fingerprint, snapshot, result.upstream_result_id);

      const compatible = reuseScreen ? matchesReviewMaterial(result, yield* savedResultContext(session, result.result_id), current, candidate, null, null)
        : currentFingerprint === result.input_fingerprint;

      if (!compatible) return yield* new JudgeStateError({ message: "Current stage inputs differ from reusable result" });
    } else if (options.current_source_text_fingerprints !== undefined) return yield* new JudgeStateError({ message: "Current source-text fingerprints require a current manifest" });

    if (result.stage === "title_screen") {
      if (candidateRun.full_result_id !== null || (candidateRun.screening_result_id !== null && candidateRun.screening_result_id !== selectedResult)) {
        return yield* new JudgeStateError({ message: "Accepted screening result cannot be overwritten" });
      }

      yield* session.sql`UPDATE review_run_candidates SET status=${jsonProperty(result.value, "outcome") === "screened_out" ? "screened_out" : "screened"},screening_result_id=${selectedResult} WHERE run_id=${selectedRun} AND listing_id=${identity}`;
    } else {
      if (candidateRun.full_result_id !== null && candidateRun.full_result_id !== selectedResult) return yield* new JudgeStateError({ message: "Accepted full-review result cannot be overwritten" });

      const screen = yield* session.sql<{ result_id: string; result_json: string }>`SELECT result_id,result_json FROM stage_results WHERE listing_id=${identity} AND stage='title_screen' AND result_id=${candidateRun.screening_result_id}`;

      if (!screen[0] || jsonProperty(yield* parseStoredJson(screen[0].result_json), "outcome") !== "advance_to_full_review" || result.upstream_result_id !== screen[0].result_id) {
        return yield* new JudgeStateError({ message: "Full review needs the current accepted screening result" });
      }

      yield* session.sql`UPDATE review_run_candidates SET status='completed',full_result_id=${selectedResult} WHERE run_id=${selectedRun} AND listing_id=${identity}`;
    }

    return { ...result, stale: false };
  }));
}).pipe(Effect.mapError(sqlError));

export interface MatchingReviewOptions {
  readonly snapshot_ids: ReadonlySet<string>;
  readonly detail_changed: string | null;
  readonly source_material?: string;
  readonly now: bigint;
}

const MatchingRow = Schema.Struct({ ...ProvenanceResultRow.fields, context_json: Schema.String });

export const matchingFullReview = (session: JudgeSession, candidate: CandidateProjection, input: StageInput, options: MatchingReviewOptions) => Effect.gen(function* () {
  if (input.source_text_fingerprint === null) return null;

  const exists = yield* session.sql`SELECT 1 FROM sqlite_master WHERE name='review_result_contexts'`;

  if (exists.length === 0) return null;

  const rows = yield* session.sql`SELECT r.*,c.snapshot_provenance_json,x.context_json FROM stage_results r JOIN stage_attempts a ON a.attempt_id=r.attempt_id JOIN stage_attempt_candidates c ON c.attempt_id=r.attempt_id AND c.listing_id=r.listing_id JOIN review_result_contexts x ON x.result_id=r.result_id WHERE r.listing_id=${input.listing_id} AND r.stage='full_review' AND r.stage_version<>${REJUDGE_STAGE_VERSION} AND a.profile_id=${session.profile_id} AND a.status='completed' AND c.source_text_fingerprint=${input.source_text_fingerprint} ORDER BY r.recorded_at DESC,r.rowid DESC`;

  for (const raw of rows) {
    const decoded = yield* Effect.either(Effect.gen(function* () {
      const { snapshot_provenance_json, context_json, ...saved } = yield* decodeStored(MatchingRow, raw);
      const parsed = yield* parseSnapshotProvenance(snapshot_provenance_json);
      const context = yield* parseStoredJson(context_json);
      const result = yield* decodeResult(saved);

      return { parsed, context, result };
    }));

    if (Either.isLeft(decoded)) continue;

    const { parsed, context, result } = decoded.right;

    if (parsed === null || parsed.format_version !== 1 || !Predicate.isRecord(context) || (parsed.expires_at !== null && (yield* instant(parsed.expires_at)) <= options.now) || jsonProperty(context, "detail_missing") !== candidate.detail_missing || jsonProperty(result.value, "ad_text_reviewed") !== true) continue;

    const sameSnapshot = parsed.snapshot_id !== null && options.snapshot_ids.has(parsed.snapshot_id);
    const sameRefresh = parsed.refresh !== null && parsed.refresh.detail_changed === options.detail_changed && parsed.expires_at === candidate.expires_at && ["title", "employer", "locations"].every((key) => pythonJson(jsonProperty(context, key)) === pythonJson(jsonProperty(candidateJson(candidate), key)));

    const material = context["review_source_material"];
    const sameMaterial = Predicate.isString(material) && material === options.source_material;

    if (sameMaterial || (material === undefined && (sameSnapshot || sameRefresh))) return result;
  }

  return null;
}).pipe(Effect.mapError(sqlError));
