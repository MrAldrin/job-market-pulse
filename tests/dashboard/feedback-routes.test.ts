import { Database } from "bun:sqlite";
import { Clock, Effect, Layer, Redacted } from "effect";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FEEDBACK_EVENTS_PATH } from "../../src/lib/contracts/feedback-events.ts";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { loginCredentials, signSession } from "../../src/lib/server/dashboard/auth.ts";
import { dashboardConfigTest, type DashboardSettings } from "../../src/lib/server/dashboard/config.ts";
import { DashboardServer, DashboardServerLive } from "../../src/lib/server/dashboard/service.ts";
import { LocalProfileSettings } from "../../src/lib/server/profile/local-settings.ts";
import { DashboardSnapshot } from "../../src/lib/server/dashboard/snapshot.ts";
import { PHONE_FEEDBACK_DDL } from "../../src/lib/server/feedback/phone-store-schema.ts";

const host = "viewer.synthetic.test";
const bearer = "Bearer " + "invented_".repeat(6);
const listing = "approved-listing";
const browserPath = "/app/shortlist-feedback";
const legacyBrowserPath = "/shortlist-feedback";
const starredPath = "/api/v1/starred-jobs";
const goodBody = JSON.stringify({ listing_id: listing, field: "starred", value: true });
const login = loginCredentials("invented", "invented-password-large", "invented-secret-for-unit-tests-only");

if (login === null) throw new Error("Invalid test credentials");

const session = signSession(login.sessionKey, Date.parse("2026-10-19T13:00:00Z") / 1000);
const cookie = "jmp_session=" + session;

let dataDir: string;
let snapshotReads: number;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pulse-feedback-routes-"));
  snapshotReads = 0;
});

afterEach(() => rm(dataDir, { recursive: true, force: true }));

const paths = () => ({ dataDir, snapshotDb: join(dataDir, "digests.sqlite"), feedbackDb: join(dataDir, "shortlist-feedback.sqlite3") });

const serve = (changes: Partial<DashboardSettings> = {}, snapshotProfile = "invented") => {
  const settings: DashboardSettings = {
    mode: "local", port: 8770, allowedHosts: [host], snapshotFile: null,
    ...paths(), feedbackProfile: "invented", login, starred: {
      sourceInstance: "invented-instance", profileId: "invented", token: Redacted.make(bearer.slice("Bearer ".length)),
    }, ...changes,
  };

  const none = Effect.succeed(null);

  const server = DashboardServerLive.pipe(Layer.provide(dashboardConfigTest(settings)), Layer.provide(Layer.succeed(DashboardSnapshot, {
    readDocument: none, readJson: none, readFeedbackContext: Effect.sync(() => {
      snapshotReads++;

      return { profile_id: snapshotProfile, listing_ids: [listing] };
    }),
  })), Layer.provide(Layer.succeed(LocalProfileSettings, {
    read: () => Effect.dieMessage("Unexpected settings read"), save: () => Effect.dieMessage("Unexpected settings write"),
    refreshModels: () => Effect.dieMessage("Unexpected discovery"), testModel: () => Effect.dieMessage("Unexpected model test"),
  })), Layer.provide(FixedOsloClock));

  return (program: Effect.Effect<void, never, DashboardServer>) => Effect.runPromise(Effect.provide(program, server));
};

const request = (route: string, method = "GET", headers?: HeadersInit, body?: string) => {
  const values = new Headers({ host });

  if (body !== undefined) {
    values.set("content-length", String(new TextEncoder().encode(body).byteLength));
    values.set("content-type", "application/json");
  }

  for (const [key, value] of new Headers(headers)) values.set(key, value);

  const init: RequestInit = { method, headers: values };

  if (body !== undefined) init.body = body;

  return new Request(`https://${host}${route}`, init);
};

const send = (request: Request, socketAddress = "192.0.2.1") => Effect.flatMap(DashboardServer, (s) => s.handle({ request, socketAddress }));

const csrfToken = async (response: Response | undefined) => {
  if (response?.status !== 200) throw new Error("Expected the feedback GET to succeed");
  const { csrf_token } = await response.json();

  expect(csrf_token).toMatch(/^[0-9a-f]{64}$/);

  return String(csrf_token);
};

const withDot = (path: string) => path.replace(/\/([^/]+)$/, "/./$1");

test("Railway denies feedback and exports even with old configuration and valid credentials", async () => {
  await serve({ mode: "railway" })(Effect.gen(function* () {
    const server = yield* DashboardServer;
    expect(server.capabilities({ request: request(browserPath), socketAddress: "127.0.0.1" }).canGiveFeedback).toBe(false);

    for (const path of [browserPath, legacyBrowserPath, starredPath, FEEDBACK_EVENTS_PATH]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const response = yield* send(request(path, method, { cookie, authorization: bearer },
          method === "POST" ? goodBody : undefined), "127.0.0.1");

        expect(response?.status).toBe(404);
        expect(response?.headers.get("location")).toBeNull();
      }
    }
  }));
  expect(snapshotReads).toBe(0);
  await expect(lstat(paths().feedbackDb)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([starredPath, FEEDBACK_EVENTS_PATH, withDot(starredPath), withDot(FEEDBACK_EVENTS_PATH)])("%s applies the read-only bearer gate before source access", async (route) => {
  // Request normalizes dot segments before the handler; this is not a raw HTTP test.
  await serve()(Effect.gen(function* () {
    const cases = [
      [request(route, "GET", { host: "wrong.invalid", authorization: bearer }), 403],
      [request(route, "GET", { cookie }), 401],
      [request(route, "GET", { authorization: `${bearer}, ${bearer}` }), 401],
      [request(route, "GET", { authorization: bearer.replace("Bearer", "bearer") }), 401],
      [request(route, "GET", { authorization: `${bearer}x` }), 401],
      [request(route, "HEAD", { authorization: bearer }), 405],
      [request(route, "POST", { authorization: bearer }, goodBody), 405],
      [request(route + "?", "GET", { authorization: bearer }), 400],
      [request(route + "?profile_id=other", "GET", { authorization: bearer }), 400],
      [request(route, "GET", { authorization: bearer, "content-type": "application/json" }), 400],
      [request(route, "GET", { authorization: bearer, "content-length": "0, 0" }), 400],
      [request(route, "GET", { authorization: bearer }), 503],
      [request(browserPath, "GET", { authorization: bearer }), 303],
      [request(browserPath, "POST", { authorization: bearer }, goodBody), 303],
    ] as const;

    for (const [incoming, expected] of cases) {
      const response = yield* send(incoming);

      expect(response?.status).toBe(expected);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
      expect(response?.headers.get("location") === null).toBe(expected !== 303);

      if (incoming.method === "HEAD") expect(response?.body).toBeNull();
    }
  }));
  expect(snapshotReads).toBe(0);
  await expect(lstat(paths().feedbackDb)).rejects.toMatchObject({ code: "ENOENT" });
  await serve({ starred: null })(Effect.gen(function* () {
    expect((yield* send(request(route, "GET", { authorization: bearer })))?.status).toBe(404);
    expect((yield* send(request(route, "POST", { origin: `https://${host}` })))?.status).toBe(404);
  }));
});

test("write requests need one signed session, exact Origin and CSRF, and the exact bounded JSON shape", async () => {
  await serve()(Effect.gen(function* () {
    expect((yield* send(request(browserPath, "GET", { host: "outside.invalid", cookie })))?.status).toBe(403);
    expect((yield* send(request(browserPath, "GET", { cookie: `${cookie}; ${cookie}` })))?.status).toBe(303);
    expect((yield* send(request(browserPath, "GET", { "x-real-ip": "127.0.0.1", "x-forwarded-for": "127.0.0.1" })))?.status).toBe(303);

    const response = yield* send(request(browserPath, "GET", { cookie }));
    const csrf = yield* Effect.promise(() => csrfToken(response));
    const headers = { cookie, origin: `https://${host}`, "x-csrf-token": csrf };

    for (const changed of [
      { origin: "null" }, { origin: `https://${host}/` }, { origin: `http://${host}` },
      { origin: `https://${host}, https://${host}` }, { "x-csrf-token": `${csrf}, ${csrf}` },
      { "x-csrf-token": "f".repeat(64) },
    ]) expect((yield* send(request(browserPath, "POST", { ...headers, ...changed }, goodBody)))?.status).toBe(403);

    for (const [body, status] of [
      [`{"listing_id":"${listing}","field":"starred","value":false,"value":true}`, 400],
      [JSON.stringify({ listing_id: listing, field: "starred", value: true, profile_id: "other" }), 400],
      [JSON.stringify({ listing_id: "out-of-capture", field: "starred", value: true }), 404],
      [" ".repeat(1025), 413],
    ] as const) expect((yield* send(request(browserPath, "POST", headers, body)))?.status).toBe(status);

    expect((yield* send(request(browserPath + "?", "POST", headers, goodBody)))?.status).toBe(400);
    expect((yield* send(request(browserPath, "POST", { ...headers, "content-type": "application/json; charset=utf-8" }, goodBody)))?.status).toBe(400);

    const fresh = yield* send(request(browserPath, "GET", { cookie }));

    expect(yield* Effect.promise(() => fresh?.text() ?? Promise.resolve(""))).toContain('"starred":false');
  }));
  expect(snapshotReads).toBe(3); // Initial and final GET, plus the syntactically valid capture miss.
});

test.each([browserPath, legacyBrowserPath])("normalized %s still needs a signed session, Origin and CSRF", async (path) => {
  const route = withDot(path);

  await serve()(Effect.gen(function* () {
    const read = yield* send(request(route, "GET", { cookie }));
    const csrf = yield* Effect.promise(() => csrfToken(read));
    const origin = `https://${host}`;
    const accepted = { cookie, origin, "x-csrf-token": csrf };
    const bytes = () => Effect.promise(() => readFile(paths().feedbackDb));
    const before = yield* bytes();

    const cases = [
      [request(route, "GET", { ...accepted, host: "outside.invalid" }), 403],
      [request(route, "GET", { authorization: bearer }), 303],
      [request(route + "?profile_id=other", "GET", accepted), 404],
      [request(route, "POST", { ...accepted, host: "outside.invalid" }, goodBody), 403],
      [request(route, "POST", { origin, "x-csrf-token": csrf, authorization: bearer }, goodBody), 303],
      [request(route, "POST", { ...accepted, origin: "https://outside.invalid" }, goodBody), 403],
      [request(route, "POST", { cookie, "x-csrf-token": csrf }, goodBody), 403],
      [request(route, "POST", { cookie, origin }, goodBody), 403],
      [request(route, "POST", { ...accepted, "x-csrf-token": "not-the-token" }, goodBody), 403],
      [request(route + "?profile_id=other", "POST", accepted, goodBody), 400],
    ] as const;

    for (const [incoming, expected] of cases) expect((yield* send(incoming))?.status).toBe(expected);

    expect(snapshotReads).toBe(1);
    expect(yield* bytes()).toEqual(before);

    const unchanged = yield* send(request(browserPath, "GET", { cookie }));

    expect(yield* Effect.promise(() => unchanged?.text() ?? Promise.resolve(""))).toContain('"starred":false');
    expect((yield* send(request(route, "POST", accepted, goodBody)))?.status).toBe(200);
    const written = yield* send(request(browserPath, "GET", { cookie }));

    expect(yield* Effect.promise(() => written?.text() ?? Promise.resolve(""))).toContain('"starred":true');
  }));
});

test("the explicit profile and snapshot must match, even for the authorized local socket", async () => {
  for (const profile of [null, "different"]) {
    await serve({ mode: "local", feedbackProfile: profile, login: null })(Effect.gen(function* () {
      expect((yield* send(request(browserPath), "127.0.0.1"))?.status).toBe(404);
      expect((yield* send(request(browserPath, "GET", { "x-forwarded-for": "127.0.0.1" }), "192.0.2.1"))?.status).toBe(303);
    }));
  }

  expect(snapshotReads).toBe(1);
  await expect(lstat(paths().feedbackDb)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses the snapshot path and non-private feedback files without changing them", async () => {
  const { snapshotDb, feedbackDb } = paths();
  const bytes = Buffer.from("invented snapshot source");
  await writeFile(snapshotDb, bytes, { flag: "wx", mode: 0o600 });
  await serve({ feedbackDb: snapshotDb })(Effect.gen(function* () {
    expect((yield* send(request(browserPath, "GET", { cookie })))?.status).toBe(503);
  }));

  await writeFile(feedbackDb, bytes, { flag: "wx", mode: 0o600 });
  await chmod(feedbackDb, 0o644);
  await serve()(Effect.gen(function* () {
    expect((yield* send(request(browserPath, "GET", { cookie })))?.status).toBe(503);
  }));
  expect(await readFile(snapshotDb)).toEqual(bytes);
  expect(await readFile(feedbackDb)).toEqual(bytes);
});

test("starred exports report the UTC time and saved feedback time", async () => {
  const { feedbackDb } = paths();
  const nextSecond = "2026-10-19T12:00:01+00:00";
  const db = new Database(":memory:");

  try {
    db.run(PHONE_FEEDBACK_DDL);
    db.run("INSERT INTO shortlist_feedback VALUES (?, ?, 1, NULL, ?)", ["invented", listing, nextSecond]);
    await writeFile(feedbackDb, db.serialize(), { flag: "wx", mode: 0o600 });
  } finally { db.close(); }

  await serve()(Effect.gen(function* () {
    const clock = yield* Effect.clock;

    const response = yield* send(request(starredPath, "GET", { authorization: bearer })).pipe(Effect.withClock({
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      currentTimeMillis: Effect.succeed(Date.parse(nextSecond)),
      currentTimeNanos: clock.currentTimeNanos,
      unsafeCurrentTimeMillis: () => clock.unsafeCurrentTimeMillis(),
      unsafeCurrentTimeNanos: () => clock.unsafeCurrentTimeNanos(),
      sleep: (duration) => clock.sleep(duration),
    }));

    expect(response?.status).toBe(200);
    expect(yield* Effect.promise(() => response?.json() ?? Promise.resolve(null))).toMatchObject({
      exported_at: nextSecond, jobs: [{ listing_id: listing, feedback_updated_at: nextSecond }],
    });
  }));
});
