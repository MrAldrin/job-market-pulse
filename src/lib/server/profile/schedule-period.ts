import { DateTime, Either, Match, Option, Schema, flow } from "effect";
import { decodeStrict } from "../../contracts/support.ts";
import { isoEpochMillis, parseIsoDate, parseIsoTime } from "../../contracts/iso-time.ts";
import { OSLO_ZONE } from "../clock.ts";
import { PeriodError } from "./errors.ts";
import { caseFold, words } from "../shared/text.ts";

const examples = "Examples: weekly fri 09:00; every 3 days.";
const periodError = (message: string) => new PeriodError({ message: `${message} ${examples}` });
const fail = (message = "Invalid schedule period.") => Either.left(periodError(message));

const weekdays = [
  ["mon", "monday", "man", "mandag"],
  ["tue", "tuesday", "tir", "tirsdag"],
  ["wed", "wednesday", "ons", "onsdag"],
  ["thu", "thursday", "tor", "torsdag"],
  ["fri", "friday", "fre", "fredag"],
  ["sat", "saturday", "lør", "lørdag"],
  ["sun", "sunday", "søn", "søndag"],
];

export const PeriodSchema = Schema.Struct({
  kind: Schema.Literal("daily", "weekly", "every_n_weeks", "monthly", "every_n_days"),
  n: Schema.optionalWith(Schema.Int, { default: () => 1 }),
  weekday: Schema.optionalWith(Schema.NullOr(Schema.Int), { default: () => null }),
  day_of_month: Schema.optionalWith(Schema.NullOr(Schema.Int), { default: () => null }),
  time: Schema.optionalWith(Schema.String, { default: () => "09:00" }),
  anchor: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
});

export type Period = typeof PeriodSchema.Type;

const textSchema = decodeStrict(Schema.String);
const periodSchema = decodeStrict(PeriodSchema);
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateMillis = (s: string): number | undefined => {
  const m = datePattern.exec(s);

  if (!m || m[1] === "0000") {
    return undefined;
  }

  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setUTCHours(0, 0, 0, 0);

  return d.toISOString().slice(0, 10) === s ? d.getTime() : undefined;
};

const dateText = (millis: number): string | undefined => {
  const d = new Date(millis);

  return Number.isFinite(millis) && d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999 ? d.toISOString().slice(0, 10) : undefined;
};

const dayMs = 86400000;
const weekday = (ms: number) => (new Date(ms).getUTCDay() + 6) % 7;
const clockValid = (s: string) => /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(s);

export const validatePeriod = flow(
  periodSchema,
  Either.mapLeft(() => periodError("Invalid schedule period.")),
  Either.flatMap((input): Either.Either<Period, PeriodError> => {
  const p = {
    ...input,
    weekday: input.weekday ?? (input.kind === "weekly" || input.kind === "every_n_weeks" ? 4 : null),
    day_of_month: input.day_of_month ?? (input.kind === "monthly" ? 1 : null),
  };

  if (!clockValid(p.time)) {
    return fail("Use a real HH:MM time.");
  }

  if (p.n < 1 || p.n > (p.kind === "every_n_weeks" ? 52 : 90)) {
    return fail("The interval is outside its allowed range.");
  }

  if (!["every_n_weeks", "every_n_days"].includes(p.kind) && p.n !== 1) {
    return fail();
  }

  if (p.kind === "weekly" || p.kind === "every_n_weeks") {
    if (p.weekday === null || p.weekday < 0 || p.weekday > 6) {
      return fail("Choose a valid weekday.");
    }
  }
  else if (p.weekday !== null) {
    return fail();
  }

  if (p.kind === "monthly") {
    if (p.day_of_month === null || p.day_of_month < 1 || p.day_of_month > 28) {
      return fail("The day of month must be from 1 to 28.");
    }
  }
  else if (p.day_of_month !== null) {
    return fail();
  }

  if (p.kind === "every_n_days" || p.kind === "every_n_weeks") {
    const anchor = p.anchor === null ? undefined : dateMillis(p.anchor);

    if (anchor === undefined) {
      return fail("An interval needs an anchor date.");
    }

    if (p.kind === "every_n_weeks" && weekday(anchor) !== p.weekday) {
      return fail("The anchor must be on the chosen weekday.");
    }
  }
  else if (p.anchor !== null) {
    return fail();
  }

  return Either.right(p);
}));

export const normalizeUserTime = flow(
  textSchema,
  Either.mapLeft(() => periodError("Use a real HHMM or HH:MM time.")),
  Either.flatMap((text): Either.Either<string, PeriodError> => {
  if (!/^[0-9]{2}:?[0-9]{2}$/.test(text)) {
    return fail("Use a real HHMM or HH:MM time.");
  }

  const compact = text.replace(":", "");
  const result = `${compact.slice(0, 2)}:${compact.slice(2)}`;

  return clockValid(result) ? Either.right(result) : fail("Use a real HH:MM time.");
}));

export const parsePeriod = (text: string, today: string): Either.Either<Period, PeriodError> => {
  const decoded = decodeStrict(Schema.Struct({ text: Schema.String, today: Schema.String }))({ text, today });

  if (Either.isLeft(decoded)) {
    return fail();
  }

  const todayMs = dateMillis(decoded.right.today);

  if (todayMs === undefined) {
    return fail();
  }

  const parts = [...words(caseFold(decoded.right.text))];

  if (!parts.length) {
    return fail();
  }

  let time = "09:00";

  if (parts.at(-1)?.includes(":")) {
    time = parts.pop() ?? "";

    if (!clockValid(time)) {
      return fail("Use a real HH:MM time.");
    }
  }

  let kind: Period["kind"];
  let n = 1;

  if (parts[0] === "daily" || parts[0] === "weekly" || parts[0] === "monthly") {
    kind = parts[0];
    parts.shift();
  }
  else if (parts[0] === "fortnightly") {
    kind = "every_n_weeks";
    n = 2;
    parts.shift();
  }
  else if (parts[0] === "every" && parts[1] === "week") {
    kind = "weekly";
    parts.splice(0, 2);
  }
  else if (parts[0] === "every" && /^[0-9]{1,3}$/.test(parts[1] ?? "") && ["week", "weeks", "day", "days"].includes(parts[2] ?? "")) {
    n = Number(parts[1]);
    kind = parts[2]?.startsWith("week") ? "every_n_weeks" : "every_n_days";
    parts.splice(0, 3);
  }
  else {
    return fail();
  }

  let chosenWeekday: number | null = null;
  let dayOfMonth: number | null = null;
  let anchor: string | null = null;

  if (kind === "weekly" || kind === "every_n_weeks") {
    chosenWeekday = 4;

    if (parts.length) {
      const name = parts.shift();
      chosenWeekday = weekdays.findIndex((names) => names.some((alias) => alias === name));

      if (chosenWeekday < 0) {
        return fail("Choose a valid weekday.");
      }
    }

    if (kind === "every_n_weeks") {
      anchor = dateText(todayMs + ((chosenWeekday - weekday(todayMs) + 7) % 7) * dayMs) ?? null;

      if (anchor === null) {
        return fail("Anchor date is out of range.");
      }
    }
  }
  else if (kind === "monthly") {
    dayOfMonth = 1;

    if (parts.length) {
      const s = parts.shift() ?? "";

      if (!/^[0-9]{1,2}$/.test(s)) {
        return fail();
      }

      dayOfMonth = Number(s);
    }
  }
  else if (kind === "every_n_days") {
    anchor = decoded.right.today;
  }

  if (parts.length) {
    return fail();
  }

  return validatePeriod({ kind, n, weekday: chosenWeekday, day_of_month: dayOfMonth, time, anchor });
};

export const parseUserPeriod = (text: string, today: string): Either.Either<Period, PeriodError> => {
  const decoded = textSchema(text);

  if (Either.isLeft(decoded)) {
    return fail();
  }

  const parts = [...words(decoded.right)];
  const last = parts.at(-1) ?? "";

  if (parts.length > 1 && (last.includes(":") || /^[0-9]{4}$/.test(last))) {
    const prefix = parsePeriod(parts.slice(0, -1).join(" "), today);

    if (Either.isLeft(prefix)) {
      return prefix;
    }

    const clock = normalizeUserTime(last);

    if (Either.isLeft(clock)) {
      return Either.left(clock.left);
    }

    parts[parts.length - 1] = clock.right;
    text = parts.join(" ");
  }

  return parsePeriod(text, today);
};

export const normalize = (value: typeof PeriodSchema.Encoded): Either.Either<string, PeriodError> => Either.map(validatePeriod(value), (p) => {
  if (p.kind === "weekly" || p.kind === "every_n_weeks") {
    return `${p.kind === "weekly" ? "weekly" : `every ${p.n} weeks`} ${weekdays[p.weekday ?? 0]?.[0]} ${p.time}`;
  }

  if (p.kind === "monthly") {
    return `monthly ${p.day_of_month} ${p.time}`;
  }

  if (p.kind === "every_n_days") {
    return `every ${p.n} days ${p.time}`;
  }

  return `daily ${p.time}`;
});

export const onCalendar = (value: typeof PeriodSchema.Encoded): Either.Either<string | null, PeriodError> => Either.map(validatePeriod(value), (p) => {
  if (p.kind === "every_n_days" || p.kind === "every_n_weeks") {
    return null;
  }

  if (p.kind === "weekly") {
    const day = weekdays[p.weekday ?? 0]?.[0] ?? "";

    return `${day[0]?.toUpperCase()}${day.slice(1)} *-*-* ${p.time}:00`;
  }

  return p.kind === "monthly" ? `*-*-${String(p.day_of_month).padStart(2, "0")} ${p.time}:00` : `*-*-* ${p.time}:00`;
});

const firstDay = (p: Period, after: number): number => {
  if (p.kind === "every_n_days" || p.kind === "every_n_weeks") {
    const anchor = dateMillis(p.anchor ?? "") ?? 0;
    const interval = p.n * (p.kind === "every_n_weeks" ? 7 : 1) * dayMs;

    return anchor + Math.ceil(Math.max(0, after - anchor) / interval) * interval;
  }

  if (p.kind === "weekly") {
    return after + (((p.weekday ?? 0) - weekday(after) + 7) % 7) * dayMs;
  }

  if (p.kind === "monthly") {
    const d = new Date(after);
    d.setUTCDate(p.day_of_month ?? 1);

    if (d.getTime() < after) {
      d.setUTCMonth(d.getUTCMonth() + 1);
    }

    return d.getTime();
  }

  return after;
};

const advance = (p: Period, day: number): number => {
  if (p.kind === "monthly") {
    const date = new Date(day);
    date.setUTCMonth(date.getUTCMonth() + 1);

    return date.getTime();
  }

  const interval = Match.value(p.kind).pipe(
    Match.when("daily", () => 1),
    Match.when("weekly", () => 7),
    Match.when("every_n_weeks", () => p.n * 7),
    Match.orElse(() => p.n),
  );

  return day + interval * dayMs;
};

export const isDue = (value: typeof PeriodSchema.Encoded, day: string): Either.Either<boolean, PeriodError> => {
  const p = validatePeriod(value);

  if (Either.isLeft(p)) {
    return Either.left(p.left);
  }

  const decodedDay = textSchema(day);
  const ms = Either.isRight(decodedDay) ? dateMillis(decodedDay.right) : undefined;

  if (ms === undefined) {
    return fail();
  }

  const first = firstDay(p.right, ms);

  return dateText(first) === undefined ? fail("No more run dates can be represented.") : Either.right(first === ms);
};

export const ScheduleSchema = Schema.Struct({
  schedule: Schema.optional(Schema.String), anchor: Schema.optional(Schema.Unknown),
});

const scheduleValidator = (fallback: string) => flow(
  decodeStrict(ScheduleSchema),
  Either.mapLeft(() => periodError("The schedule must be a table or has an unknown setting.")),
  Either.flatMap((value): Either.Either<void, PeriodError> => {
  if (!Object.keys(value).length) {
    return Either.right(undefined);
  }

  const expression = value.schedule ?? fallback;

  if (expression === "never") {
    return "anchor" in value ? fail("A disabled schedule cannot have an anchor.") : Either.right(undefined);
  }

  const period = parsePeriod(expression, "2000-01-01");

  if (Either.isLeft(period)) {
    return period;
  }

  if (value.anchor !== undefined && value.anchor !== null) {
    if (period.right.anchor === null) {
      return fail("Only interval schedules accept an anchor.");
    }

    const saved = parseIsoDate(String(value.anchor));

    if (Option.isNone(saved)) {
      return fail("An interval schedule needs a valid saved anchor.");
    }

    const checked = validatePeriod({ ...period.right, anchor: saved.value.text });

    if (Either.isLeft(checked)) {
      return fail("An interval schedule needs a valid saved anchor.");
    }
  }

  return Either.right(undefined);
}));

export const validateScheduleInput = scheduleValidator("weekly");
export const validateSchedule = (value: typeof ScheduleSchema.Encoded, fallback = "weekly") => scheduleValidator(fallback)(value);

const osloParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: DateTime.zoneToString(OSLO_ZONE),
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  era: "short",
});

const localParts = (ms: number) => Object.fromEntries(osloParts.formatToParts(ms).map((part) => [part.type, part.value]));

const localDate = (ms: number): string => {
  const parts = localParts(ms);

  return parts.era === "AD" ? `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day}` : "";
};

// Runs are ISO strings with their Oslo offset, so the two fold instants stay distinct.
export const nextRuns = (value: typeof PeriodSchema.Encoded, after: string, count = 3): Either.Either<readonly string[], PeriodError> => {
  const p = validatePeriod(value);

  if (Either.isLeft(p)) {
    return Either.left(p.left);
  }

  const parsed = parseIsoTime(after);

  if (Option.isNone(parsed) || !parsed.value.aware) {
    return fail("The reference time needs a timezone.");
  }

  const decodedCount = decodeStrict(Schema.Int.pipe(Schema.nonNegative()))(count);

  if (Either.isLeft(decodedCount)) {
    return fail("Run count must be a nonnegative integer.");
  }

  const runCount = decodedCount.right;

  if (runCount === 0) {
    return Either.right([]);
  }

  const threshold = parsed.value.epochMicros;
  const local = dateMillis(localDate(isoEpochMillis(parsed.value)));

  if (local === undefined) {
    return fail("No more run dates can be represented.");
  }

  let day = firstDay(p.right, local);
  const result: string[] = [];

  while (result.length < runCount) {
    const date = dateText(day);

    if (date === undefined) {
      return fail("No more run dates can be represented.");
    }

    const [hour, minute] = p.right.time.split(":").map(Number);
    const wall = day + (hour ?? 0) * 3600000 + (minute ?? 0) * 60000;
    // Oslo historical offsets can include seconds; derive candidate offsets near the wall time.
    const offsets = new Set<number>();

    for (const sample of [wall - dayMs, wall, wall + dayMs]) {
      const x = localParts(sample);
      const localDay = dateMillis(localDate(sample));

      if (localDay !== undefined) {
        offsets.add(localDay + Number(x.hour) * 3600000 + Number(x.minute) * 60000 + Number(x.second) * 1000 - sample);
      }
    }

    const candidates = [...offsets].flatMap((offset) => {
      const instant = wall - offset;
      const x = localParts(instant);

      return localDate(instant) === date && `${x.hour}:${x.minute}:${x.second}` === `${p.right.time}:00`
        ? [{ offset, instant }] : [];
    }).sort((a, b) => a.instant - b.instant);

    const candidate = candidates[0];

    if (candidate && BigInt(candidate.instant) * 1000n > threshold) {
      const sign = candidate.offset < 0 ? "-" : "+";
      const seconds = Math.abs(candidate.offset / 1000);
      const offset = `${sign}${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}${seconds % 60 ? `:${String(seconds % 60).padStart(2, "0")}` : ""}`;
      result.push(`${date}T${p.right.time}:00${offset}`);
    }

    if (result.length < runCount) {
      day = advance(p.right, day);
    }
  }

  return Either.right(result);
};

export const parsePeriodInput = flow(
  decodeStrict(Schema.Struct({ text: Schema.String, today: Schema.String })),
  Either.mapLeft(() => periodError("Invalid schedule period.")),
  Either.flatMap(({ text, today }) => parsePeriod(text, today)),
);

export const nextRunsInput = flow(
  decodeStrict(Schema.Struct({
    period: PeriodSchema,
    after: Schema.String,
    count: Schema.optionalWith(Schema.Int.pipe(Schema.nonNegative()), { default: () => 3 }),
  })),
  Either.mapLeft(() => periodError("Invalid run input.")),
  Either.flatMap(({ period, after, count }) => nextRuns(period, after, count)),
);
