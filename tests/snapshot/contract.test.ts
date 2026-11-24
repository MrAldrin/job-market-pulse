import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSnapshotBytes, decodeSnapshotDocumentBytes } from "../../src/lib/contracts/snapshot.ts";
import type { JsonInput } from "../../src/lib/server/shared/json-input.ts";
import { examplePersonalInputs, exampleRunFunnel, exampleSettings } from "./settings-fixture.ts";

const fixture = JSON.parse(readFileSync("contracts/fixtures/snapshot.example.json", "utf8"));
const bytes = (value: JsonInput) => new TextEncoder().encode(JSON.stringify(value));
const check = (value: JsonInput) => decodeSnapshotBytes(bytes(value));

describe("snapshot v1 contract", () => {
  it("accepts the realistic fixture and nullable sections", () => {
    expect(Either.isRight(check(fixture))).toBe(true);
    expect(Either.isRight(check({ ...fixture, market: null, reviewed_trend: null, salary: null }))).toBe(true);
  });
  it("rejects unknown fields at the root and within a job", () => {
    const root = structuredClone(fixture); root.extra = true;
    const nested = structuredClone(fixture); nested.jobs[0].assessment.extra = true;
    expect(Either.isLeft(check(root))).toBe(true);
    expect(Either.isLeft(check(nested))).toBe(true);
  });
  it("rejects unsupported claims and invalid references", () => {
    const claim = structuredClone(fixture); claim.jobs[0].assessment.evidence = [];
    const shortlist = structuredClone(fixture); shortlist.shortlist.job_ids = [shortlist.jobs[11].id];
    const salary = structuredClone(fixture); salary.salary.ads[0].job_id = "unknown";
    const duplicate = structuredClone(fixture); duplicate.jobs[1].id = duplicate.jobs[0].id;

    for (const value of [claim, shortlist, salary, duplicate]) expect(Either.isLeft(check(value))).toBe(true);
  });
  it("rejects market gaps, misalignment and unordered trends", () => {
    const gap = structuredClone(fixture); gap.market.monthly.families[0].counts[5] = 1;
    const alignment = structuredClone(fixture); alignment.market.monthly.terms[0].tech_counts.pop();
    const order = structuredClone(fixture); order.reviewed_trend.weekly.push({ label: "earlier", start: "2025-01-01", count: 1 });
    const months = structuredClone(fixture); months.salary.monthly.push({ ...months.salary.monthly[0] });

    for (const value of [gap, alignment, order, months]) expect(Either.isLeft(check(value))).toBe(true);
  });
  it("rejects invalid timestamps, dates, duplicate JSON keys and oversized input", () => {
    const timestamp = structuredClone(fixture); timestamp.generated_at = "2026-01-01T12:00:00";
    const date = structuredClone(fixture); date.salary.ads[0].changed = "2026-02-30 12:00";
    expect(Either.isLeft(check(timestamp))).toBe(true);
    expect(Either.isLeft(check(date))).toBe(true);
    expect(Either.isLeft(decodeSnapshotBytes(new TextEncoder().encode('{"schema":1,"schema":1}')))).toBe(true);
    expect(Either.isLeft(decodeSnapshotBytes(new Uint8Array(8_000_001)))).toBe(true);
  });
});

describe("snapshot v3 contract", () => {
  const v3 = { ...fixture, schema_version: 3, settings: exampleSettings };

  it("accepts v3 settings and does not upgrade older snapshots", () => {
    expect(Either.getOrThrow(decodeSnapshotDocumentBytes(bytes(v3)))).toEqual(v3);
    expect(Either.isLeft(check(v3))).toBe(true);
    expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v3, schema_version: 1 })))).toBe(true);
    expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v3, schema_version: 2, market_history: null })))).toBe(true);
    expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...fixture, schema_version: 3 })))).toBe(true);
    expect(Either.getOrThrow(decodeSnapshotDocumentBytes(bytes({ ...fixture, schema_version: 2, market_history: null })))).not.toHaveProperty("settings");
  });

  it("rejects unknown settings keys, path-shaped model labels and invalid recurrence", () => {
    const { filters, review, schedule } = exampleSettings;

    const settings = [
      { ...exampleSettings, raw_config: "invented-private-data" },
      { ...exampleSettings, filters: { ...filters, home_postcode: "1234" } },
      { ...exampleSettings, filters: { ...filters, excluded_employers: Array.from({ length: 33 }, () => "x".repeat(1000)) } },
      { ...exampleSettings, review: { ...review, judge: { ...review.judge, token: "invented-secret" } } },
      { ...exampleSettings, review: { ...review, judge: { ...review.judge, model: "invented/../private/model" } } },
      { ...exampleSettings, schedule: { ...schedule, weekday: null } },
      { ...exampleSettings, schedule: { ...schedule, anchor: "2026-11-14" } },
      { ...exampleSettings, schedule: { kind: "never", timezone: "Europe/Oslo", enabled: false } },
    ];

    for (const value of settings) expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v3, settings: value })))).toBe(true);
  });
});

describe("snapshot v5 contract", () => {
  const v4 = { ...fixture, schema_version: 4, settings: exampleSettings, personal_inputs: examplePersonalInputs };
  const v5 = { ...v4, schema_version: 5, run_funnel: exampleRunFunnel };
  const read = (value: JsonInput) => decodeSnapshotDocumentBytes(bytes(value));

  it("keeps legacy reads strict and an unverified pool distinct from zero", () => {
    expect(Either.getOrThrow(read(v5))).toEqual(v5);
    expect(Either.getOrThrow(read({ ...v5, run_funnel: { nav_events: 0, pool: null } }))).toMatchObject({ run_funnel: { nav_events: 0, pool: null } });
    expect(Either.getOrThrow(read(v4))).not.toHaveProperty("run_funnel");
    expect(Either.isLeft(read({ ...v5, schema_version: 4 }))).toBe(true);
    expect(Either.isLeft(read({ ...v4, schema_version: 5 }))).toBe(true);
  });

  it("rejects imbalanced counts, wrong fit references and new unknown fields", () => {
    const { nav_events, pool } = exampleRunFunnel;

    if (!pool) throw new Error("Expected pool in synthetic fixture");

    const invalid = [
      { ...pool, filters: { ...pool.filters, occupation: 10 } },
      { ...pool, screen: { ...pool.screen, undecided: 5 } },
      { ...pool, judge: { ...pool.judge, unfinished: 3 } },
      { ...pool, waiting: 9 },
      { ...pool, listed_review_ids: [...pool.listed_review_ids, pool.listed_review_ids[0]] },
      { ...pool, listed_review_ids: [...pool.listed_review_ids, "unknown-ad"] },
      { ...pool, listed_review_ids: v4.shortlist.job_ids },
      { ...pool, details: "unexpected" },
    ];

    for (const candidate of invalid) expect(Either.isLeft(read({ ...v5, run_funnel: { nav_events, pool: candidate } }))).toBe(true);
    expect(Either.isLeft(read({ ...v5, counts: { ...v5.counts, closed: 2 } }))).toBe(true);
    expect(Either.isLeft(read({ ...v5, run_funnel: { ...exampleRunFunnel, nav_events: -1 } }))).toBe(true);
  });
});

describe("snapshot v6 contract", () => {
  const base = Either.getOrThrow(check(fixture));
  const jobs = base.jobs.map((job, index) => ({ ...job, distance_km: [0, 3.75][index] ?? null }));
  const v6 = { ...base, schema_version: 6, settings: exampleSettings, personal_inputs: examplePersonalInputs, jobs, run_funnel: null };
  const read = (value: JsonInput) => decodeSnapshotDocumentBytes(bytes(value));

  it("keeps zero, measured and unknown distances distinct", () => {
    expect(Either.getOrThrow(read(v6))).toEqual(v6);
    expect(Either.getOrThrow(read({ ...v6, run_funnel: exampleRunFunnel }))).toMatchObject({ run_funnel: exampleRunFunnel });
    expect(Either.isLeft(read({ ...v6, schema_version: 5, run_funnel: exampleRunFunnel }))).toBe(true);
    expect(Either.isLeft(read({ ...v6, jobs: base.jobs }))).toBe(true);
  });

  it.each([-1, 21_001, "4 km", true])("rejects invalid distance %s", (distance_km) => {
    expect(Either.isLeft(read({ ...v6, jobs: jobs.map((job, index) => index === 0 ? { ...job, distance_km } : job) }))).toBe(true);
  });
});

describe("snapshot v4 contract", () => {
  const v3 = { ...fixture, schema_version: 3, settings: exampleSettings };
  const v4 = { ...v3, schema_version: 4, personal_inputs: examplePersonalInputs };

  it("keeps v3 readable and requires private inputs for v4", () => {
    expect(Either.getOrThrow(decodeSnapshotDocumentBytes(bytes(v3)))).not.toHaveProperty("personal_inputs");
    expect(Either.getOrThrow(decodeSnapshotDocumentBytes(bytes(v4)))).toEqual(v4);
    expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v3, schema_version: 4 })))).toBe(true);
    expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v4, schema_version: 3 })))).toBe(true);
  });

  it("rejects out-of-bounds values and additional private fields", () => {
    const { home_location, narrative } = examplePersonalInputs;

    const inputs = [
      { home_location, narrative: "ø".repeat(50_001) },
      { home_location: { ...home_location, origin: { ...home_location.origin, latitude: 91 } }, narrative },
      { home_location: { ...home_location, path: "/invented/location" }, narrative },
      { home_location, narrative, token: "invented-token" },
    ];

    for (const personal_inputs of inputs) expect(Either.isLeft(decodeSnapshotDocumentBytes(bytes({ ...v4, personal_inputs })))).toBe(true);
  });
});
