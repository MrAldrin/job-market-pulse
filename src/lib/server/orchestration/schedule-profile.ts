import { DateTime, Effect, Option } from "effect";
import { join } from "node:path";
import { isoEpochMillis, parseIsoDate, parseIsoTime } from "../../contracts/iso-time.ts";
import { OSLO_ZONE } from "../clock.ts";
import { dateToken, decodeProfileId, decodeProfileSettings } from "../profile/core.ts";
import { PeriodError } from "../profile/errors.ts";
import { ProfileFiles } from "../profile/files.ts";
import { Profile } from "../profile/service.ts";
import { parsePeriod, parseUserPeriod, validatePeriod, type Period } from "../profile/schedule-period.ts";

const failure = (message: string) => new PeriodError({ message });

export const osloDate = (now: string) => Effect.gen(function* () {
  const parsed = parseIsoTime(now);

  if (Option.isNone(parsed) || !parsed.value.aware) return yield* failure("Schedule time must be an aware timestamp");

  return DateTime.unsafeMake(isoEpochMillis(parsed.value)).pipe(DateTime.setZone(OSLO_ZONE), DateTime.formatIsoDate);
});

export interface ProfilePeriodOptions {
  readonly now: string;
  readonly text?: string;
  readonly anchor?: string;
  readonly requireAnchor?: boolean;
}

// Timer previews and the due gate use the same selected Profile authority. This
// reads no model setting, opens no database, and does not require a ready source.
export const profilePeriod = (rawRoot: string, profileId: string, options: ProfilePeriodOptions) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const profiles = yield* Profile;
  yield* decodeProfileId(profileId);
  const root = yield* files.root(rawRoot);
  const cadence = yield* profiles.cadence(root, profileId);
  const text = yield* files.read(root, join(root, "local_only", "profiles", profileId, "profile.toml"));
  const config = yield* decodeProfileSettings(text);
  const schedule = config.schedule;
  const expression = options.text ?? schedule?.schedule ?? (cadence.kind === "weekly" ? "weekly" : "every 2 weeks");

  if (expression === "never") return yield* failure("This profile schedule is disabled (never).");
  const today = yield* osloDate(options.now);
  const period = yield* (options.text === undefined ? parsePeriod(expression, today) : parseUserPeriod(expression, today));
  const saved = options.anchor ?? (options.text === undefined && period.anchor !== null ? schedule?.anchor ?? cadence.anchor : null);

  if (saved !== null && saved !== undefined) {
    if (period.anchor === null) return yield* failure("Only interval schedules accept an anchor.");
    const anchor = parseIsoDate(dateToken(saved));

    if (Option.isNone(anchor)) return yield* failure("An interval schedule needs a valid saved anchor.");

    return yield* validatePeriod({ ...period, anchor: anchor.value.text });
  }

  if (options.requireAnchor && period.anchor !== null) return yield* failure("The due check needs a saved or explicit interval anchor.");

  return period satisfies Period;
});
