import { Effect, Either, Redacted } from "effect";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeSnapshotBytes, type Snapshot } from "../../src/lib/contracts/snapshot.ts";
import { newTopJobsMessage, ntfyTransport, scheduledFailureMessage, testNtfyMessage, topJobIds } from "../../src/lib/server/alert/ntfy.ts";

const topic = "invented-random-topic-01234567";
const link = "https://dashboard.example.test/app/";
const fixture = Either.getOrThrow(decodeSnapshotBytes(readFileSync("contracts/fixtures/snapshot.example.json")));

const top: Snapshot["jobs"][number] = {
  ...fixture.jobs[0]!, status: "open", title: `Invented\nEngineer \u202E${topic}`, employer: "Invented Company",
  assessment: { fit: "exceptional", reason: "private reason", evidence: ["private evidence"], uncertainties: [], hard_constraints: "pass", ad_text_reviewed: true },
};

const withJobs = (...jobs: Snapshot["jobs"]): Snapshot => ({ ...fixture, jobs });

test("one bounded message for newly exceptional open IDs, with only titles, employers and the dashboard link", () => {
  const before = topJobIds(withJobs({ ...top, id: "seen" }));

  const after = withJobs(top, { ...top, id: "seen", title: "known" }, { ...top, id: "closed", status: "closed" }, {
    ...top, id: "strong", assessment: { ...top.assessment, fit: "strong" },
  });

  const result = newTopJobsMessage(before, after, link, Redacted.make(topic));
  expect(result).toEqual({ title: "Job Market Pulse: 1 new exceptional match", message: "Invented Engineer [redacted] — Invented Company", click: link });
  expect(JSON.stringify(result)).not.toMatch(/private reason|private evidence|invented-random-topic/);
  expect(newTopJobsMessage(topJobIds(after), after, link, Redacted.make(topic))).toBeNull();

  const many = withJobs(...Array.from({ length: 50 }, (_, index) => ({ ...top, id: String(index), title: "😀".repeat(300) })));
  const summary = newTopJobsMessage(before, many, link, Redacted.make(topic));
  expect(summary?.title).toContain("50 new");
  expect(summary?.message).toMatch(/And \d+ more/);
  expect(new TextEncoder().encode(summary?.message).length).toBeLessThan(4096);
});

test("one fixed HTTPS JSON request, no redirects, and no acknowledgement body or error disclosure", async () => {
  const calls: (readonly [string, RequestInit])[] = [];

  const transport = ntfyTransport(async (url, init) => {
    calls.push([url, init]);

    return new Response(`untrusted response ${topic}`);
  });

  const secret = Redacted.make(topic);

  for (const message of [scheduledFailureMessage, testNtfyMessage]) {
    expect(await Effect.runPromise(transport.post(secret, message))).toBe(true);
    const [url, init] = calls.at(-1)!;
    expect(url).toBe("https://ntfy.sh");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } });
    expect(init.body).toBe(JSON.stringify({ topic, ...message }));
  }

  expect(calls).toHaveLength(2);
  const rejected = ntfyTransport(async () => new Response(topic, { status: 403 }));
  const failed = ntfyTransport(async () => { throw new Error(topic); });
  expect(await Effect.runPromise(rejected.post(secret, testNtfyMessage))).toBe(false);
  expect(await Effect.runPromise(failed.post(secret, testNtfyMessage))).toBe(false);
});
