import { readFile } from "node:fs/promises";
import { Either } from "effect";
import { expect, test } from "vitest";
import { decodeFeedbackEvents, decodeFeedbackEventsBytes } from "../../src/lib/contracts/feedback-events.ts";

const wireLimit = 2 * 1024 * 1024;
const document = { schema: "pulse.feedback_events", schema_version: 1n, profile_id: "invented" };

const star = {
  event_id: "star:invented-job:2026-01-14T09:00:00.000001+01:00",
  listing_id: "invented-job",
  source: "nav",
  source_version: null,
  kind: "star",
  value: false,
  reason: "",
  created_at: "2026-01-14T09:00:00.000001+01:00",
  origin: "phone_shortlist",
  result_id: null,
};

test("decodes the published feedback events example and a frozen phone projection", async () => {
  const example = new URL("../../contracts/fixtures/feedback_events.example.json", import.meta.url);
  const oracle = new URL("../oracle/viewer-api/feedback/star-events.json", import.meta.url);
  const fixture = await readFile(example);
  const recordedEvents: unknown = JSON.parse(await readFile(oracle, "utf8"));

  expect(decodeFeedbackEventsBytes(fixture, wireLimit)).toEqual(Either.right(JSON.parse(fixture.toString("utf8"))));
  expect(decodeFeedbackEvents({ ...document, events: recordedEvents })).toEqual(
    Either.right({ ...document, schema_version: 1, events: recordedEvents }),
  );
});

test("preserves the timestamp, false star value and null or empty context", () => {
  expect(decodeFeedbackEvents({ ...document, events: [star] })).toEqual(
    Either.right({ ...document, schema_version: 1, events: [star] }),
  );
});

test("rejects duplicate IDs, invalid event values and unknown or missing fields", () => {
  for (const events of [
    [star, { ...star, kind: "reaction", value: "up" }],
    [{ ...star, kind: "reaction", value: null }],
    [{ ...star, kind: "legacy_verdict", value: "very_good" }],
    [{ ...star, value: 0 }],
    [{ ...star, created_at: "2026-01-14T09:00:00" }],
    [{ ...star, listing_id: "\u0085 " }],
    [{ ...star, additional: true }],
    [{ ...star, result_id: undefined }],
  ]) {
    expect(Either.isLeft(decodeFeedbackEvents({ ...document, events }))).toBe(true);
  }
});

test("a required field must belong to the event, not its prototype", () => {
  const inherited = Object.setPrototypeOf({ ...star }, { result_id: null });
  Reflect.deleteProperty(inherited, "result_id");

  expect(Either.isLeft(decodeFeedbackEvents({ ...document, events: [inherited] }))).toBe(true);
});

test("enforces the lexical version and rejects duplicate keys or oversized bytes", () => {
  const raw = '{"schema":"pulse.feedback_events","schema_version":1,"profile_id":"invented","events":[]}';
  const encode = (text: string) => new TextEncoder().encode(text);

  for (const body of [raw.replace(":1,", ":1.0,"), raw.replace(":1,", ":1e0,"), raw.replace(":1,", ":2,"), raw.replace('"events":[]', '"events":[],"events":[]')]) {
    expect(Either.isLeft(decodeFeedbackEventsBytes(encode(body), wireLimit))).toBe(true);
  }

  expect(Either.isLeft(decodeFeedbackEventsBytes(encode(raw), raw.length - 1))).toBe(true);
  expect(Either.isRight(decodeFeedbackEventsBytes(encode(raw), raw.length))).toBe(true);
});
