import { DateTime, Either, Option, Schema } from "effect";
import { parseIsoDate, parseIsoTime } from "../../contracts/iso-time.ts";
import { OSLO_ZONE } from "../clock.ts";
import type { PythonJson } from "../shared/python-json.ts";
import { instant } from "./core.ts";
import { JudgeStateError } from "./errors.ts";

// Private facts, not a Source wire or a second Source reader. The eventual
// accepted Source adapter supplies these from one owned read-only snapshot.
// Optional-table absence and row absence both supply null: neither is closure.
export interface HistorySourceFacts {
  readonly ad: { readonly changed: string; readonly expires: string | null | undefined } | null;
  readonly status: { readonly status: string; readonly changed: string } | null;
  readonly version: string | null;
  readonly application_deadline: { readonly changed: string; readonly value: string | null; readonly rolling: boolean } | null;
}

export const HistoryLifecycleStatus = Schema.Literal("confirmed_closed", "application_deadline_passed", "expiry_unverified", "source_expired", "current_status_unknown", "earlier_refresh", "saved_source_unconfirmed");

export type HistoryLifecycleStatus = Schema.Schema.Type<typeof HistoryLifecycleStatus>;

export interface HistoryLifecycleOptions {
  readonly saved_version: string;
  readonly expires_at: string | null;
  readonly now: bigint;
  readonly reviewed_detail_changed?: PythonJson;
  readonly reviewed_expiry_version?: PythonJson;
}

export interface HistoryLifecycle {
  readonly lifecycle_status: HistoryLifecycleStatus;
  readonly expires_at?: string | null;
  // Present only when a matching deadline ledger enriches a retained Source ad.
  readonly application_due?: string | null;
}

export type Deadline = Option.Option<bigint>;

export const parseDeadline = (value: PythonJson | undefined): Deadline => {
  const input = Schema.decodeUnknownOption(Schema.String)(value);

  if (Option.isNone(input) || !input.value) return Option.none();

  if (input.value.length === 10) {
    const date = parseIsoDate(input.value);

    if (Option.isNone(date)) return Option.none();

    const following = new Date(date.value.millis + 86_400_000);

    // Frozen date + timedelta also overflows beyond the supported year range.
    if (following.getUTCFullYear() > 9999) throw new RangeError("Deadline exceeds the supported date range");

    const boundary = DateTime.makeZoned(following, { timeZone: OSLO_ZONE, adjustForTimeZone: true });

    return Option.map(boundary, (value) => BigInt(DateTime.toEpochMillis(value)) * 1000n);
  }

  const parsed = parseIsoTime(input.value);

  return Option.isSome(parsed) && parsed.value.aware ? Option.some(parsed.value.epochMicros) : Option.none();
};

export const deadlinePassed = (deadline: Deadline, now: bigint): boolean => Option.isSome(deadline) && now >= deadline.value;

const sourceExpiry = (facts: HistorySourceFacts, options: HistoryLifecycleOptions): Either.Either<string | null | undefined, JudgeStateError> => {
  const ad = facts.ad;

  if (options.reviewed_expiry_version !== undefined) {
    const version = Schema.decodeUnknownEither(Schema.Union(Schema.Literal(1), Schema.Literal(1n)))(options.reviewed_expiry_version);

    if (Either.isLeft(version)) return Either.right(undefined);

    if (ad === null) return Either.right(options.expires_at);

    const sourceVersion = instant(ad.changed);
    const reviewedVersion = Option.flatMap(Schema.decodeUnknownOption(Schema.String)(options.reviewed_detail_changed), (value) => Either.getRight(instant(value)));
    const newer = Either.isRight(sourceVersion) && Option.isSome(reviewedVersion) && sourceVersion.right > reviewedVersion.value;

    if (!newer) return Either.right(options.expires_at);
  }

  if (ad === null) return Either.right(facts.version === null || facts.version === options.saved_version ? options.expires_at : null);

  if (ad.expires === undefined) return Either.left(new JudgeStateError({ message: "Historical source ad has no expiry field" }));

  return Either.right(ad.expires);
};

export const sourceLifecycle = (facts: HistorySourceFacts, options: HistoryLifecycleOptions): Either.Either<HistoryLifecycle, JudgeStateError> => Either.gen(function* () {
  const ad = facts.ad;
  const status = facts.status;
  const expiry = sourceExpiry(facts, options);
  const displayed = Either.getOrUndefined(expiry);
  const expiryField = displayed === undefined ? {} : { expires_at: displayed };

  // Closure evidence takes precedence even if there is no verified expiry.
  if (status !== null && ["INACTIVE", "STOPPED", "DELETED"].includes(status.status)) {
    const statusVersion = yield* instant(status.changed);

    if (statusVersion >= (yield* instant(options.saved_version)) && (ad === null || statusVersion >= (yield* instant(ad.changed)))) {
      return { ...expiryField, lifecycle_status: "confirmed_closed" };
    }
  }

  const currentVersion = ad?.changed ?? facts.version ?? options.saved_version;
  const due = facts.application_deadline;
  let enrichment: { readonly application_due: string | null } | undefined;

  if (due !== null && (yield* instant(due.changed)) === (yield* instant(currentVersion))) {
    if (ad !== null) enrichment = { application_due: due.rolling ? "Snarest" : due.value };

    if (!due.rolling && deadlinePassed(parseDeadline(due.value), options.now)) return { ...enrichment, ...expiryField, lifecycle_status: "application_deadline_passed" };
  }

  const expiresAt = yield* expiry;

  if (expiresAt === undefined) return { ...enrichment, lifecycle_status: "expiry_unverified" };
  const resolved = { ...enrichment, expires_at: expiresAt };

  if (deadlinePassed(parseDeadline(expiresAt), options.now)) return { ...resolved, lifecycle_status: "source_expired" };

  if (ad === null) return { ...resolved, lifecycle_status: "current_status_unknown" };

  return { ...resolved, lifecycle_status: ad.changed !== options.saved_version ? "earlier_refresh" : "saved_source_unconfirmed" };
});
