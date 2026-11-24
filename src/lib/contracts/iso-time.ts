import { Option } from "effect";

export interface IsoDate {
  readonly text: string;
  readonly millis: number;
}

export interface IsoTime {
  readonly date: IsoDate;
  readonly aware: boolean;
  readonly epochMicros: bigint;
}

const dayMillis = 86_400_000;

const calendarDate = (year: number, month: number, day: number): Option.Option<IsoDate> => {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return Option.none();
  }

  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);

  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    return Option.none();
  }

  return Option.some({ text: value.toISOString().slice(0, 10), millis: value.getTime() });
};

// Python fromisoformat accepts calendar and ISO week dates, but not ordinal dates.
export const parseIsoDate = (text: string): Option.Option<IsoDate> => {
  const calendar = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);

  if (calendar && (text.length === 8 || text.length === 10)) {
    return calendarDate(Number(calendar[1]), Number(calendar[2]), Number(calendar[3]));
  }

  const week = /^(\d{4})(?:-W(\d{2})(?:-([1-7]))?|W(\d{2})([1-7])?)$/.exec(text);

  if (!week) return Option.none();

  const year = Number(week[1]);
  const number = Number(week[2] ?? week[4]);
  const weekday = Number(week[3] ?? week[5] ?? "1");
  const january = calendarDate(year, 1, 4);

  if (Option.isNone(january) || number < 1 || number > 53) return Option.none();

  const monday = january.value.millis - ((new Date(january.value.millis).getUTCDay() + 6) % 7) * dayMillis;
  const thursday = new Date(monday + ((number - 1) * 7 + 3) * dayMillis);
  const value = new Date(monday + ((number - 1) * 7 + weekday - 1) * dayMillis);

  if (thursday.getUTCFullYear() !== year) return Option.none();

  return calendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
};

// Pulse timestamps use calendar dates and colon-separated clocks. Keep the
// fractional digits used by Source version and digest freshness comparisons.
const timestampPattern = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?(Z|([+-])([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?$/;

export const parseIsoTime = (text: string): Option.Option<IsoTime> => {
  const match = timestampPattern.exec(text);

  if (!match || match[0] !== text) {
    return Option.map(parseIsoDate(text), (date) => ({ date, aware: false, epochMicros: BigInt(date.millis) * 1000n }));
  }

  const [, day, hour, minute, second = "0", fraction = "", zone, sign, offsetHour = "0", offsetMinute = "0", offsetSecond = "0"] = match;
  const seconds = Number(hour) * 3600 + Number(minute) * 60 + Number(second);
  const offset = (Number(offsetHour) * 3600 + Number(offsetMinute) * 60 + Number(offsetSecond)) * (sign === "-" ? -1 : 1);
  const micros = BigInt(fraction.slice(0, 6).padEnd(6, "0"));

  return Option.map(parseIsoDate(day!), (date) => ({
    date,
    aware: zone !== undefined,
    epochMicros: BigInt(date.millis) * 1000n + BigInt(seconds - offset) * 1_000_000n + micros,
  }));
};

export const isoEpochMillis = (value: IsoTime): number => {
  const quotient = value.epochMicros / 1000n;

  return Number(value.epochMicros < 0n && value.epochMicros % 1000n !== 0n ? quotient - 1n : quotient);
};
