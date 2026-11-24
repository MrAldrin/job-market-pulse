import { Either, Schema } from "effect";
import { Digest } from "../../contracts/judge-state.ts";
import { awareTimestamp, integerToken } from "../../contracts/support.ts";
import { parseStrictContractJson } from "../shared/strict-contract-json.ts";
import { fingerprint, instant, utcText } from "./core.ts";
import { JudgeStateError } from "./errors.ts";

const Refresh = Schema.Struct({
  source: Schema.Literal("nav_detail_refresh"),
  previous_changed: awareTimestamp.pipe(Schema.maxLength(64)),
  detail_changed: awareTimestamp.pipe(Schema.maxLength(64)),
  refreshed_at: awareTimestamp.pipe(Schema.maxLength(64)),
});

const LegacySnapshot = Schema.Struct({ snapshot_id: Schema.NullOr(Digest), provenance: Schema.NullOr(Refresh) });

const CurrentSnapshot = Schema.Struct({
  format_version: Schema.compose(integerToken, Schema.Literal(1)),
  snapshot_id: Digest,
  expires_at: Schema.NullOr(awareTimestamp.pipe(Schema.maxLength(64))),
  provenance: Schema.NullOr(Refresh),
});

export interface SnapshotProvenance {
  readonly snapshot_id: string | null;
  readonly refresh: typeof Refresh.Type | null;
  readonly format_version: 1 | null;
  readonly expires_at: string | null;
}

const invalid = () => new JudgeStateError({ message: "Snapshot provenance is invalid" });

const normalizedTimestamp = (text: string) => Either.flatMap(instant(text), (micros) =>
  Either.map(utcText(micros), (value) => value.replace(".000000+", "+")),
);

export const parseSnapshotProvenance = (text: string | null): Either.Either<SnapshotProvenance | null, JudgeStateError> => Either.gen(function* () {
  if (text === null) return null;

  const raw = yield* Either.mapLeft(parseStrictContractJson(text, 1024), invalid);
  const decoded = yield* Either.mapLeft(Schema.decodeUnknownEither(Schema.Union(CurrentSnapshot, LegacySnapshot), { onExcessProperty: "error" })(raw), invalid);
  const current = "format_version" in decoded;
  let refresh = decoded.provenance;

  if (refresh !== null) {
    const previous = yield* instant(refresh.previous_changed);
    const detail = yield* instant(refresh.detail_changed);

    if (detail <= previous) return yield* Either.left(invalid());

    if (current) refresh = { ...refresh, detail_changed: yield* normalizedTimestamp(refresh.detail_changed) };
  }

  return {
    snapshot_id: decoded.snapshot_id,
    refresh,
    format_version: current ? 1 : null,
    expires_at: current && decoded.expires_at !== null ? yield* normalizedTimestamp(decoded.expires_at) : null,
  };
});

export const snapshotBindingId = (text: string | null, sourceVersion: string | null = null) => Either.gen(function* () {
  const parsed = yield* parseSnapshotProvenance(text);

  if (parsed === null || parsed.snapshot_id === null) return null;

  if (parsed.format_version !== 1) return parsed.snapshot_id;

  const detail = parsed.refresh?.detail_changed ?? sourceVersion;

  return fingerprint({
    format_version: 1,
    snapshot_id: parsed.snapshot_id,
    expires_at: parsed.expires_at,
    detail_changed: detail === null ? null : yield* normalizedTimestamp(detail),
  });
});

export const validateSnapshotAdmission = (parsed: SnapshotProvenance | null, sourceVersion: string, sourceExpiry: string | null) => Either.gen(function* () {
  if (parsed === null) return;

  if (parsed.refresh !== null) {
    if (parsed.format_version !== 1) return yield* Either.left(new JudgeStateError({ message: "Refreshed snapshot has no durable expiry" }));

    const previous = yield* instant(parsed.refresh.previous_changed);
    const source = yield* instant(sourceVersion);

    if (previous !== source) return yield* Either.left(invalid());
  }

  if (parsed.format_version !== 1 || sourceExpiry === null) return;

  const source = yield* instant(sourceExpiry);
  const reviewed = parsed.expires_at === null ? null : yield* instant(parsed.expires_at);

  if (reviewed === null || reviewed > source) {
    return yield* Either.left(new JudgeStateError({ message: "Reviewed expiry exceeds source admission expiry" }));
  }
});
