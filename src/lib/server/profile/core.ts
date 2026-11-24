import { Either, Predicate, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { TomlDate } from "smol-toml";
import { ProfileSettings } from "../../contracts/profile-settings.ts";
import { ProfileId, type Cadence, type ProfileBundle, type ProfilePaths, type ProfileStatus } from "../../contracts/profile.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { parseToml } from "../shared/toml.ts";
import { PythonFloat, pythonJson } from "../shared/python-json.ts";
import { ProfileError } from "./errors.ts";

const invalid = () => new ProfileError({ message: "Invalid profile configuration" });

export const decodeProfileId = (id: string) => Either.mapLeft(decodeStrict(ProfileId)(id), () => new ProfileError({ message: "Profile ID must be a lowercase slug using letters, digits, and single hyphens" })).pipe(
  Either.flatMap((slug) => process.platform === "win32" && unsafeWindowsSegment(slug)
    ? Either.left(new ProfileError({ message: "Profile ID is a reserved Windows filename" })) : Either.right(slug)),
);

export const decodeProfileSettings = (text: string) => Either.flatMap(parseToml(text), (raw) => Either.mapLeft(decodeStrict(ProfileSettings)(raw), invalid));

export const initialProfileConfig = (id: string): Either.Either<string, ProfileError> => Either.map(decodeProfileId(id), () =>
  `[profile]\nid = "${id}"\n\n[paths]\nprofile = "profile.md"\npreferences = "preferences.toml"\nsource_db = "data/REPLACE_WITH_SHARED_FEED.sqlite3"\nreview_db = "review.sqlite3"\nledger_db = "ledger.sqlite3"\noutbox = "outbox"\n\n[policy]\nmode = "passive"\nmarket_only = false\nfreshness_max_age_hours = 24\n`,
);

export const validDate = (text: string): boolean => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) || text.startsWith("0000")) return false;

  const date = new Date(text + "T00:00:00Z");

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

export const dateToken = (date: string | bigint | TomlDate): string => date instanceof TomlDate ? date.toISOString() : String(date);

export const parseCadence = (policy: ProfileSettings["policy"]): Either.Either<Cadence, ProfileError> => {
  const kind = policy.cadence ?? "weekly";
  const anchor = policy.cadence_anchor === undefined ? null : dateToken(policy.cadence_anchor);

  if (kind === "weekly" && anchor !== null) return Either.left(new ProfileError({ message: "cadence_anchor is only valid with fortnightly cadence" }));

  if (kind === "fortnightly" && (anchor === null || !validDate(anchor))) {
    return Either.left(new ProfileError({ message: "fortnightly cadence requires cadence_anchor as a valid ISO date" }));
  }

  return Either.right({ kind, anchor });
};

export const weekDue = (cadence: Cadence, day: string): Either.Either<boolean, ProfileError> => {
  if (!validDate(day)) return Either.left(new ProfileError({ message: "Invalid calendar day" }));

  if (cadence.kind === "weekly" || cadence.anchor === null) return Either.right(true);

  if (!validDate(cadence.anchor)) return Either.left(invalid());

  const monday = (text: string): number => {
    const date = new Date(text + "T00:00:00Z");

    return date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000;
  };

  return Either.right(Math.floor((monday(day) - monday(cadence.anchor)) / 604_800_000) % 2 === 0);
};

const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(right + sep) || right.startsWith(left + sep);

export const unsafeWindowsSegment = (name: string): boolean => name !== "." && (
  /[<>:"|?*]/u.test(name) || [...name].some((character) => character.charCodeAt(0) < 32) || /[ .]$/u.test(name)
  || /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(name)
);

export const pathsFor = (root: string, id: string, config: ProfileSettings): Either.Either<ProfilePaths, ProfileError> => {
  const directory = join(root, "local_only", "profiles", id);
  const paths = config.paths;
  const windows = process.platform === "win32";
  const comparable = (path: string) => windows ? normalize(path).toLowerCase() : normalize(path);
  const privatePaths = [paths.profile, paths.preferences, paths.review_db, paths.ledger_db, paths.outbox];
  const privateValues = privatePaths.map(comparable);
  const active = [paths.profile, paths.review_db, paths.ledger_db, paths.outbox, "filters.toml", "screen.toml", "judge.toml", "profile.toml"].map(comparable);

  if (windows && [...privatePaths, paths.source_db].some((path) => path.split("/").some(unsafeWindowsSegment))) {
    return Either.left(new ProfileError({ message: "Profile storage paths contain an invalid Windows filename" }));
  }

  if ((windows ? paths.source_db.toLowerCase() : paths.source_db).split("/").includes("local_only")) return Either.left(new ProfileError({ message: "Source database must not be inside local_only private data" }));

  for (const [index, value] of privateValues.entries()) {
    if (overlaps(value, "profile.toml") || privateValues.slice(index + 1).some((other) => overlaps(value, other))) {
      return Either.left(new ProfileError({ message: "Profile storage paths must be distinct and not overlap" }));
    }
  }

  for (const [index, value] of active.entries()) {
    if (active.slice(index + 1).some((other) => overlaps(value, other))) {
      return Either.left(new ProfileError({ message: "Active profile storage paths must not overlap split settings" }));
    }
  }

  const source = join(root, normalize(paths.source_db));
  const sourceRelative = relative(root, source);

  if (isAbsolute(sourceRelative) || sourceRelative.startsWith(".." + sep)) return Either.left(invalid());

  return Either.right({
    profile_id: id, directory, profile_file: join(directory, "profile.toml"), narrative_file: join(directory, paths.profile),
    // Compatibility metadata only. No resource service may inspect this legacy path at runtime.
    preferences_file: join(directory, paths.preferences), source_db: source, review_db: join(directory, paths.review_db),
    ledger_db: join(directory, paths.ledger_db), outbox_dir: join(directory, paths.outbox),
  });
};

const roundEven = (value: number): number => {
  const whole = Math.floor(value);
  const remainder = value - whole;

  return remainder === 0.5 ? whole + (whole % 2) : Math.round(value);
};

export const freshnessSeconds = (hours: number): number => {
  const whole = Math.trunc(hours);
  const micros = BigInt(whole) * 3_600_000_000n + BigInt(roundEven((hours - whole) * 3_600_000_000));

  return Number(micros) / 1_000_000;
};

export const bundleFor = (id: string, paths: ProfilePaths, config: ProfileSettings, cadence: Cadence): ProfileBundle => ({
  profile_id: id, paths,
  policy: {
    mode: config.policy.mode, max_recommendations: 120, exceptional_only: config.policy.mode === "passive",
    market_only: config.policy.market_only, freshness_max_age: { $seconds: freshnessSeconds(config.policy.freshness_max_age_hours) },
    timezone: "Europe/Oslo", cadence,
  },
  default_reviewer: config.review?.default_reviewer ?? null, full_review_batch_size: config.review?.full_review_batch_size ?? 5,
});

export const profileStatus = (bundle: ProfileBundle, reason: string | null): ProfileStatus => ({
  profile_id: bundle.profile_id, readiness: reason === null ? "ready" : "not-ready", readiness_reason: reason,
  mode: bundle.policy.mode, max_recommendations: 120, exceptional_only: bundle.policy.exceptional_only,
  market_only: bundle.policy.market_only, freshness_max_age_hours: bundle.policy.freshness_max_age.$seconds / 3600,
  timezone: "Europe/Oslo", cadence: bundle.policy.cadence.kind, cadence_anchor: bundle.policy.cadence.anchor,
  paths: { profile_config: bundle.paths.profile_file, narrative: bundle.paths.narrative_file, preferences: bundle.paths.preferences_file, source_db: bundle.paths.source_db, review_db: bundle.paths.review_db, ledger_db: bundle.paths.ledger_db, outbox: bundle.paths.outbox_dir },
});

// Type-aware reversible serialization, not comparison normalization: timedelta and policy
// hour fields are Python float values even when JavaScript Number has no fractional part.
export const encodeProfileBundle = (bundle: ProfileBundle): string => pythonJson({ ...bundle, policy: { ...bundle.policy, freshness_max_age: { $seconds: new PythonFloat(bundle.policy.freshness_max_age.$seconds) } } }, false, true);
export const encodeProfileStatus = (status: ProfileStatus): string => pythonJson({ ...status, freshness_max_age_hours: new PythonFloat(status.freshness_max_age_hours) }, false, true);

export const replaceModeText = (text: string, mode: string): Either.Either<string, ProfileError> => Either.gen(function* () {
  const validMode = Schema.is(Schema.Literal("passive", "active"));

  if (!validMode(mode)) return yield* Either.left(invalid());

  const original = yield* parseToml(text);
  const policy = original.policy;

  if (!Predicate.isRecord(policy) || !validMode(policy.mode)) return yield* Either.left(invalid());

  if (policy.mode === mode) return text;

  const expected = yield* parseToml(text);

  if (!Predicate.isRecord(expected.policy)) return yield* Either.left(invalid());

  expected.policy.mode = mode;
  const candidates: string[] = [];
  const pattern = /^([ \t]*mode[ \t]*=[ \t]*)(["'])(?:passive|active)\2(?=[ \t]*(?:#|\r?$))/gm;

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1];
    const quote = match[2];

    if (prefix === undefined || quote === undefined) continue;

    const candidate = text.slice(0, match.index) + prefix + quote + mode + quote + text.slice(match.index + match[0].length);
    const parsed = parseToml(candidate);

    if (Either.isRight(parsed) && isDeepStrictEqual(parsed.right, expected)) candidates.push(candidate);
  }

  return candidates.length === 1 && candidates[0] !== undefined ? candidates[0] : yield* Either.left(new ProfileError({ message: "Cannot safely update profile mode: need one editable policy mode" }));
});
