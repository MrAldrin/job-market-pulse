import { Either } from "effect";
import { expect, test } from "vitest";
import { instant } from "../../src/lib/server/judge/core.ts";
import { deadlinePassed as passedDeadline, parseDeadline, sourceLifecycle, type HistoryLifecycleOptions, type HistorySourceFacts } from "../../src/lib/server/judge/history-lifecycle.ts";
import { PythonFloat, type PythonJson } from "../../src/lib/server/shared/python-json.ts";

// Pure policy tests only. These facts are not a substitute Source service or
// evidence for the still-pending accepted Source adapter and read-only snapshot.
const at = (text: string) => Either.getOrThrow(instant(text));
const deadlinePassed = (value: PythonJson | undefined, now: bigint) => passedDeadline(parseDeadline(value), now);
const saved = "2026-10-01T10:00:00+00:00";
const newer = "2026-10-10T10:00:00+00:00";
const now = at("2026-10-19T12:00:00Z");
const future = "2026-11-01T10:00:00Z";
const past = "2026-10-15T10:00:00Z";
const facts: HistorySourceFacts = { ad: { changed: saved, expires: future }, status: null, version: null, application_deadline: null };
const options: HistoryLifecycleOptions = { saved_version: saved, expires_at: future, now };
const view = (input: HistorySourceFacts, selected: HistoryLifecycleOptions = options) => Either.getOrThrow(sourceLifecycle(input, selected));

test("Oslo date-only deadlines include the complete local day across both DST changes", () => {
  for (const [date, boundary] of [["2026-03-29", "2026-03-29T22:00:00Z"], ["2026-10-25", "2026-10-25T23:00:00Z"], ["2026-W43-1", "2026-10-19T22:00:00Z"]] as const) {
    expect(deadlinePassed(date, at(boundary) - 1n)).toBe(false);
    expect(deadlinePassed(date, at(boundary))).toBe(true);
  }

  expect(deadlinePassed("2026-10-19T12:00:00.000001Z", now)).toBe(false);
  expect(deadlinePassed("2026-10-19T12:00:00.000001Z", now + 1n)).toBe(true);
});

test("unknown, malformed and naive deadline values stay open-ended", () => {
  for (const value of [null, undefined, false, 1, "", "Snarest", "2026-02-31", "20261015", "2026-10-15T10:00:00", "2026-292"]) expect(deadlinePassed(value, now)).toBe(false);
});

test("only version-ordered uppercase status evidence confirms closure", () => {
  for (const status of ["INACTIVE", "STOPPED", "DELETED"]) expect(view({ ...facts, status: { status, changed: saved } }).lifecycle_status).toBe("confirmed_closed");

  expect(view({ ...facts, status: { status: "inactive", changed: saved } }).lifecycle_status).toBe("saved_source_unconfirmed");
  expect(view({ ...facts, ad: { changed: newer, expires: future }, status: { status: "INACTIVE", changed: newer } }, {
    ...options, expires_at: past, reviewed_detail_changed: saved, reviewed_expiry_version: 1,
  })).toEqual({ lifecycle_status: "confirmed_closed", expires_at: future });
  expect(view({ ...facts, status: { status: "INACTIVE", changed: "2026-09-01T10:00:00Z" } }).lifecycle_status).toBe("saved_source_unconfirmed");
  expect(view({ ...facts, ad: { changed: newer, expires: future }, status: { status: "INACTIVE", changed: saved } }).lifecycle_status).toBe("earlier_refresh");
  expect(view({ ...facts, ad: null, status: { status: "STOPPED", changed: newer } }).lifecycle_status).toBe("confirmed_closed");
});

test("absence is unknown, never evidence of removal or closure", () => {
  const absent = { ...facts, ad: null };

  expect(view(absent).lifecycle_status).toBe("current_status_unknown");
  expect(view(absent, { ...options, expires_at: past }).lifecycle_status).toBe("source_expired");
  expect(view({ ...absent, version: newer }, { ...options, expires_at: past }).lifecycle_status).toBe("current_status_unknown");
  expect(view(facts).lifecycle_status).toBe("saved_source_unconfirmed");
  expect(view({ ...facts, ad: { changed: "2026-10-01T10:00:00Z", expires: future } }).lifecycle_status).toBe("earlier_refresh");
});

test("deadline evidence must match current source version and outranks retained expiry metadata", () => {
  const deadline = { changed: saved, value: "2026-10-15", rolling: false };

  expect(view({ ...facts, application_deadline: deadline }, { ...options, reviewed_expiry_version: null })).toEqual({ lifecycle_status: "application_deadline_passed", application_due: "2026-10-15" });
  expect(view({ ...facts, application_deadline: { ...deadline, changed: newer } }).lifecycle_status).toBe("saved_source_unconfirmed");
  expect(view({ ...facts, ad: null, version: newer, application_deadline: { ...deadline, changed: newer } })).toEqual({ lifecycle_status: "application_deadline_passed", expires_at: null });
  expect(view({ ...facts, application_deadline: { ...deadline, rolling: true } })).toEqual({ lifecycle_status: "saved_source_unconfirmed", application_due: "Snarest", expires_at: future });
  expect(view({ ...facts, ad: { changed: saved, expires: past }, application_deadline: { ...deadline, rolling: true } })).toEqual({ lifecycle_status: "source_expired", application_due: "Snarest", expires_at: past });
});

test("reviewed expiry missing, version one and invalid versions stay distinct", () => {
  for (const version of [null, true, "1", 0, 2, new PythonFloat(1)]) expect(view(facts, { ...options, reviewed_expiry_version: version }).lifecycle_status).toBe("expiry_unverified");

  expect(view(facts, { ...options, reviewed_expiry_version: 1, expires_at: past }).lifecycle_status).toBe("source_expired");
  expect(view(facts, { ...options, reviewed_expiry_version: 1n, expires_at: past }).lifecycle_status).toBe("source_expired");
  expect(view({ ...facts, ad: { changed: newer, expires: future } }, { ...options, reviewed_expiry_version: 1, reviewed_detail_changed: saved, expires_at: past }).lifecycle_status).toBe("earlier_refresh");
  expect(view({ ...facts, ad: { changed: newer, expires: future } }, { ...options, reviewed_expiry_version: 1, reviewed_detail_changed: "not a timestamp", expires_at: past }).lifecycle_status).toBe("source_expired");
  expect(Either.isLeft(sourceLifecycle({ ...facts, ad: { changed: saved, expires: undefined } }, options))).toBe(true);
});

test("ACTIVE status does not confirm closure without an ad", () => {
  expect(view({ ...facts, ad: null, status: { status: "ACTIVE", changed: saved } }).lifecycle_status).toBe("current_status_unknown");
});
