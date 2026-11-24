import { describe, expect, it } from "vitest";
import { Either } from "effect";
import fc from "fast-check";
import { nextRunsInput, parsePeriodInput, validateScheduleInput, isDue, nextRuns, normalize, normalizeUserTime, onCalendar, parsePeriod, parseUserPeriod, validatePeriod, validateSchedule } from "../../src/lib/server/profile/schedule-period.ts";

const unwrap = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) {
    throw value.left;
  }

  return value.right;
};

const today = "2026-11-12";

describe("schedule period", () => {
  it("parses aliases and preserves JSON fields", () => {
    expect(unwrap(parsePeriod("EVERY 2 WEEKS MANDAG 08:00", today))).toEqual({ kind: "every_n_weeks", n: 2, weekday: 0, day_of_month: null, time: "08:00", anchor: "2026-11-16" });
    expect(unwrap(onCalendar(unwrap(parsePeriod("monthly 15 08:00", today))))).toBe("*-*-15 08:00:00");
  });
  it("preserves Python case folding and exact word separators", () => {
    expect(unwrap(parsePeriod("weekly ſun", today)).weekday).toBe(6);
    expect(unwrap(parsePeriod("daily\u001c09:00", today)).time).toBe("09:00");
    expect(unwrap(parseUserPeriod("weekly\u001cfri 1600", today)).time).toBe("16:00");
    expect(Either.isLeft(parsePeriod("daily\ufeff09:00", today))).toBe(true);
    expect(Either.isLeft(parseUserPeriod("daily\ufeff09:00", today))).toBe(true);
  });
  it("round trips relative expressions", () => fc.assert(fc.property(fc.integer({ min: 1, max: 90 }), (n) => { const p = unwrap(parsePeriod(`every ${n} days`, today)); expect(unwrap(parsePeriod(unwrap(normalize(p)), today))).toEqual(p); })));
  it("keeps saved clocks strict and validates user clocks", () => {
    expect(unwrap(parseUserPeriod("weekly fri 1600", today)).time).toBe("16:00");

    for (const text of ["daily 1600", "daily 24:00", "daily 9:00", "every 91 days", "monthly 29"]) {
      expect(Either.isLeft(parsePeriod(text, today))).toBe(true);
    }

    for (const text of ["900", "2400", "１６００", "16:00:00"]) {
      expect(Either.isLeft(normalizeUserTime(text))).toBe(true);
    }
  });
  it("respects anchors before and after the anchor date", () => {
    const p = unwrap(parsePeriod("every 2 weeks mon 08:00", today));
    expect(unwrap(isDue(p, "2026-11-02"))).toBe(false);
    expect(unwrap(isDue(p, "2026-11-30"))).toBe(true);
    expect(unwrap(nextRuns(p, "2026-11-01T00:00:00Z", 2))).toEqual(["2026-11-16T08:00:00+01:00", "2026-11-30T08:00:00+01:00"]);
  });
  it("skips DST gaps and uses only the first fold", () => {
    const p = unwrap(parsePeriod("daily 02:30", today));
    expect(unwrap(nextRuns(p, "2026-03-28T03:00:00+01:00", 1))).toEqual(["2026-03-30T02:30:00+02:00"]);
    expect(unwrap(nextRuns(p, "2026-10-24T03:00:00+02:00", 1))).toEqual(["2026-10-25T02:30:00+02:00"]);
    expect(unwrap(nextRuns(p, "2026-10-25T01:00:00Z", 1))).toEqual(["2026-10-26T02:30:00+01:00"]);
  });
  it("rejects bad saved anchors, shapes and date overflow", () => {
    expect(Either.isLeft(validateSchedule({ schedule: "every 2 weeks mon", anchor: "2026-11-17" }))).toBe(true);
    expect(Either.isLeft(validateSchedule({ schedule: "never", anchor: null }))).toBe(true);
    expect(Either.isLeft(validatePeriod({ kind: "daily", n: true, weekday: null, day_of_month: null, time: "09:00", anchor: null }))).toBe(true);
    expect(Either.isLeft(parsePeriod("every 2 weeks mon", "9999-12-31"))).toBe(true);
    expect(Either.isLeft(nextRuns(unwrap(parsePeriod("daily", today)), "9999-12-31T23:59:00Z"))).toBe(true);
  });
});

it("uses Python Period constructor defaults and rejects excess or mistyped fields", () => {
  expect(unwrap(validatePeriod({ kind: "weekly" }))).toEqual({
    kind: "weekly", n: 1, weekday: 4, day_of_month: null, time: "09:00", anchor: null,
  });
  expect(unwrap(validatePeriod({ kind: "monthly", day_of_month: null })).day_of_month).toBe(1);

  for (const value of [null, [], { kind: "daily", extra: 1 }, { kind: "daily", n: true },
    { kind: "daily", weekday: 0 }, { kind: "daily", anchor: today },
    { kind: "monthly", day_of_month: 29 }, { kind: "every_n_weeks", anchor: today }]) {
    expect(Either.isLeft(validatePeriod(value))).toBe(true);
  }
});

it.each([
  ["daily", "daily 09:00"], ["every week", "weekly fri 09:00"],
  ["fortnightly", "every 2 weeks fri 09:00"], ["monthly", "monthly 1 09:00"],
  ["monthly 28 08:00", "monthly 28 08:00"], ["every 90 days", "every 90 days 09:00"],
])("normalizes %s", (text, expected) => {
  const period = unwrap(parsePeriod(text, today));
  expect(unwrap(normalize(period))).toBe(expected);
  expect(unwrap(parsePeriod(expected, today))).toEqual(period);
});

it("accepts all frozen weekday aliases", () => {
  const aliases = [
    ["mon", "monday", "man", "mandag"], ["tue", "tuesday", "tir", "tirsdag"],
    ["wed", "wednesday", "ons", "onsdag"], ["thu", "thursday", "tor", "torsdag"],
    ["fri", "friday", "fre", "fredag"], ["sat", "saturday", "lør", "lørdag"],
    ["sun", "sunday", "søn", "søndag"],
  ];

  for (const [weekday, names] of aliases.entries()) {
    for (const name of names) {
      expect(unwrap(parsePeriod(`weekly ${name.toUpperCase()}`, today)).weekday).toBe(weekday);
    }
  }
});

it.each(["", "never", "sometimes", "daily mon", "weekly invalid", "weekly mon tue", "every",
  "every weekx", "every 0 weeks", "every 53 weeks", "every -1 weeks", "every 1.5 weeks",
  "every 0 days", "every 91 days", "every 1000 days", "every 3 months", "every 3 days fri",
  "monthly 0", "monthly 29", "monthly -1", "monthly first", "monthly 1 2",
  "daily 24:00", "daily 09:60", "daily 9:00", "daily 09:0", "daily 09:00:00", "09:00"])("rejects invalid grammar %s with examples", (text) => {
  const result = parsePeriod(text, today);
  expect(Either.isLeft(result)).toBe(true);

  if (Either.isLeft(result)) {
    expect(result.left.message).toContain("Examples: weekly fri 09:00; every 3 days.");
  }
});

it("keeps monthly and weekly runs strictly after the reference", () => {
  expect(unwrap(nextRuns({ kind: "weekly" }, "2026-11-13T09:00:00+01:00"))).toEqual([
    "2026-11-20T09:00:00+01:00", "2026-11-27T09:00:00+01:00", "2026-12-04T09:00:00+01:00",
  ]);
  expect(unwrap(nextRuns({ kind: "monthly", day_of_month: 28, time: "08:00" }, "2026-12-28T08:00:00+01:00"))).toEqual([
    "2027-01-28T08:00:00+01:00", "2027-02-28T08:00:00+01:00", "2027-03-28T08:00:00+02:00",
  ]);
  expect(unwrap(nextRuns({ kind: "daily" }, "2026-11-13T07:59:00Z", 1))).toEqual(["2026-11-13T09:00:00+01:00"]);
});

it("validates saved schedule shape, disabled schedules and weekday anchors", () => {
  for (const value of [{}, { schedule: "never" }, { anchor: null },
    { schedule: "every 2 weeks mon", anchor: "2026-11-16" }, { schedule: "every 3 days" }]) {
    expect(Either.isRight(validateScheduleInput(value))).toBe(true);
  }

  for (const value of [null, [], { extra: "weekly" }, { schedule: 1 },
    { schedule: "daily", anchor: today }, { schedule: "never", anchor: null },
    { schedule: "every 2 weeks mon", anchor: "2026-11-17" },
    { schedule: "every 3 days", anchor: "2026-02-30" }]) {
    expect(Either.isLeft(validateScheduleInput(value))).toBe(true);
  }
});

it("validates all calculation inputs even for count zero and enforces calendar bounds", () => {
  for (const count of [-1, true, 1.5, "1", null]) {
    expect(Either.isLeft(nextRunsInput({ period: { kind: "daily" }, after: "2026-11-13T00:00:00Z", count }))).toBe(true);
  }

  expect(Either.isLeft(nextRuns({ kind: "daily" }, "2026-11-13T00:00:00", 0))).toBe(true);
  expect(unwrap(nextRuns({ kind: "daily" }, "2026-11-13T00:00:00Z", 0))).toEqual([]);

  for (const date of ["0000-01-01", "2026-02-30", "10000-01-01", null]) {
    expect(Either.isLeft(parsePeriodInput({ text: "daily", today: date }))).toBe(true);
  }

  expect(Either.isLeft(nextRuns({ kind: "daily" }, "9999-12-31T23:59:00Z"))).toBe(true);
});

it("compares exact microseconds at the scheduled time", () => {
  const period = { kind: "daily", time: "09:00" } as const;
  expect(unwrap(nextRuns(period, "2026-11-13T08:59:59.999999+01:00", 1))).toEqual(["2026-11-13T09:00:00+01:00"]);
  expect(unwrap(nextRuns(period, "2026-11-13T09:00:00.000001+01:00", 1))).toEqual(["2026-11-14T09:00:00+01:00"]);
});

it("rejects rolled dates and supports saved basic/week anchors and fallback", () => {
  expect(Either.isLeft(nextRuns({ kind: "daily" }, "2026-02-30T12:00:00Z"))).toBe(true);
  expect(Either.isRight(validateSchedule({ schedule: "every 2 weeks mon", anchor: "2026W471" }))).toBe(true);
  expect(Either.isRight(validateSchedule({ schedule: "every 2 weeks mon", anchor: "20261116" }))).toBe(true);
  expect(Either.isRight(validateSchedule({ anchor: "20261116" }, "every 2 weeks mon"))).toBe(true);
});

it("keeps representable bounds in the Oslo calendar rather than the host zone", () => {
  expect(unwrap(nextRuns({ kind: "daily" }, "0001-01-01T00:00:00Z", 1))).toEqual(["0001-01-01T09:00:00+00:53:28"]);
  expect(Either.isLeft(nextRuns({ kind: "daily" }, "0001-01-01T00:00:00+23:00", 1))).toBe(true);
  expect(Either.isLeft(nextRuns({ kind: "daily" }, "9999-12-31T22:59:59Z", 1))).toBe(true);
});

it("preserves wall clocks across both DST changes and monotonic daily instants", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), (hour, minute) => {
    const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

    for (const after of ["2026-03-28T12:00:00Z", "2026-10-24T12:00:00Z"]) {
      const runs = unwrap(nextRuns({ kind: "daily", time: clock }, after));
      expect(runs.every((run) => run.slice(11, 16) === clock)).toBe(true);
      const instants = runs.map((run) => Date.parse(run));
      expect(instants[0]).toBeGreaterThan(Date.parse(after));
      expect(instants[1]).toBeGreaterThan(instants[0] ?? 0);
      expect(instants[2]).toBeGreaterThan(instants[1] ?? 0);
    }
  }));
});
