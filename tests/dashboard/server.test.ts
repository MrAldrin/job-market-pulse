import { syntheticServeHost, syntheticServeOrigin } from "../shared/serve-hosts.ts";
import { ConfigProvider, Effect, Either, Fiber, Layer, Option, TestClock } from "effect";
import { expect, test } from "vitest";
import { localSettingsPath, LocalSettingsDocument } from "../../src/lib/contracts/local-settings.ts";
import { decodeStrict } from "../../src/lib/contracts/support.ts";
import { LocalProfileSettings } from "../../src/lib/server/profile/local-settings.ts";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { ConfigLive } from "../../src/lib/server/config.ts";
import { localRunStartPath, localRunStatusPath } from "../../src/lib/contracts/local-run.ts";
import { settingsSuggestionsPath } from "../../src/lib/contracts/settings-suggestions.ts";
import { loginCredentials, serveIdentity, signSession } from "../../src/lib/server/dashboard/auth.ts";
import { DashboardConfig, DashboardConfigLive, dashboardConfigTest, type DashboardSettings } from "../../src/lib/server/dashboard/config.ts";
import { DashboardServer, DashboardServerLive } from "../../src/lib/server/dashboard/service.ts";
import { DashboardRun } from "../../src/lib/server/dashboard/run.ts";
import { DashboardSnapshot } from "../../src/lib/server/dashboard/snapshot.ts";

const login = loginCredentials("invented", "synthetic-password-0123456789", "synthetic-session-secret-0123456789");

const settings = (mode: "local" | "railway"): DashboardSettings => ({
  mode, port: 8770, allowedHosts: ["viewer.synthetic.test"], dataDir: "/synthetic/data",
  snapshotFile: null, snapshotDb: "/synthetic/data/digests.sqlite",
  feedbackDb: "/synthetic/data/shortlist-feedback.sqlite3", feedbackProfile: null, starred: null, login,
});

const noSnapshot = Effect.succeed(null);
const snapshot = Layer.succeed(DashboardSnapshot, { readDocument: noSnapshot, readJson: noSnapshot, readFeedbackContext: noSnapshot });

const unexpectedEdit = Effect.dieMessage("Local settings not available for this test");

const disabledEditor = Layer.succeed(LocalProfileSettings, {
  read: () => unexpectedEdit, save: () => unexpectedEdit, refreshModels: () => unexpectedEdit, testModel: () => unexpectedEdit,
});

const services = (mode: "local" | "railway", changes?: Partial<DashboardSettings>) => DashboardServerLive.pipe(
  Layer.provide(dashboardConfigTest({ ...settings(mode), ...changes })), Layer.provide(snapshot),
  Layer.provide(disabledEditor), Layer.provideMerge(FixedOsloClock),
);

function request(path: string, body?: string, headers?: HeadersInit): Request {
  const values = new Headers(headers);

  values.set("host", "viewer.synthetic.test");

  if (body !== undefined && !values.has("content-length")) values.set("content-length", String(new TextEncoder().encode(body).byteLength));

  return body === undefined ? new Request(`https://viewer.synthetic.test${path}`, { headers: values }) : new Request(`https://viewer.synthetic.test${path}`, { method: "POST", headers: values, body });
}

const configResult = (values: ReadonlyMap<string, string>) => Effect.runPromise(Effect.either(DashboardConfig.pipe(
  Effect.provide(DashboardConfigLive.pipe(Layer.provide(ConfigLive))),
  Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map(values)))),
)));

const serveOrigin = syntheticServeOrigin;
const serveOwner = "owner@invented.test";

const serveEnvironment = (origin = serveOrigin, owner = serveOwner) => new Map([
  ["PULSE_DASHBOARD_SERVE_ORIGIN", origin], ["PULSE_DASHBOARD_SERVE_OWNER", owner],
]);

test("Serve trust is a local-only pair, independent of outbound links and adapter headers", async () => {
  const expected = { origin: serveOrigin, host: syntheticServeHost, owner: serveOwner };

  expect(Either.getOrThrow(await configResult(serveEnvironment())).serve).toEqual(expected);
  expect(Either.getOrThrow(await configResult(new Map())).serve).toBeUndefined();

  for (const origin of [
    `http://${syntheticServeHost}`, serveOrigin + "/", serveOrigin + "?", serveOrigin + "/app/",
    serveOrigin + ":443", serveOrigin + ".invalid", `https://*.${syntheticServeHost}`, `https://bad@${syntheticServeHost}`,
  ]) expect(Either.isLeft(await configResult(serveEnvironment(origin)))).toBe(true);

  for (const owner of ["", " ", serveOwner + "\n", serveOwner + ", " + serveOwner]) {
    expect(Either.isLeft(await configResult(serveEnvironment(serveOrigin, owner)))).toBe(true);
  }

  for (const [name, value] of [
    ["ORIGIN", serveOrigin], ["HOST_HEADER", "x-forwarded-host"], ["PROTOCOL_HEADER", "x-forwarded-proto"],
    ["PORT_HEADER", "x-forwarded-port"], ["ADDRESS_HEADER", "x-forwarded-for"],
  ]) expect(Either.isLeft(await configResult(serveEnvironment().set(name!, value!)))).toBe(true);

  for (const name of serveEnvironment().keys()) {
    const values = serveEnvironment();
    values.delete(name);

    expect(Either.isLeft(await configResult(values))).toBe(true);
  }

  const hosted = serveEnvironment().set("RAILWAY_ENVIRONMENT_ID", "invented").set("DIGEST_VIEW_USER", "invented")
    .set("DIGEST_VIEW_PASSWORD", "synthetic-password-0123456789").set("DIGEST_VIEW_SESSION_SECRET", "synthetic-session-secret-0123456789");

  expect(Either.getOrThrow(await configResult(hosted)).serve).toBeUndefined();
});

test("Serve headers never admit a non-loopback request; an owner can start only via the guarded fake service", async () => {
  const serve = serveIdentity(serveOrigin, serveOwner)!;
  const target = { root: "/synthetic/root", profileId: "invented" };
  let starts = 0;

  const run = Layer.succeed(DashboardRun, {
    start: () => Effect.sync(() => {
      starts++;

      return "started" as const;
    }),
    setClosing: () => Effect.dieMessage("Unexpected desktop close"),
    status: Effect.succeed({ status: "idle" as const, log: [], current_stage: null, stages: [], started_at: null, ended_at: null, retry_at: null, reset_run_id: null, error: null }),
  });

  const layer = services("local", { serve, localSettings: target, feedbackProfile: "invented" }).pipe(Layer.provide(run));

  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const headers = { host: serve.host, "tailscale-user-login": serveOwner, "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" };

    const send = (path: string, changes?: Record<string, string>, body?: string) => {
      const values = new Headers({ ...headers, ...changes });
      const init: RequestInit = { headers: values, method: body === undefined ? "GET" : "POST" };

      if (body !== undefined) {
        values.set("content-type", "application/json");
        values.set("content-length", String(Buffer.byteLength(body)));
        init.body = body;
      }

      return new Request(serveOrigin + path, init);
    };

    for (const socketAddress of ["192.0.2.44", "100.64.0.10", ""]) {
      for (const path of ["/app/", "/app/snapshot.json", "/app/__data.json", localSettingsPath, settingsSuggestionsPath, localRunStatusPath,
        localRunStartPath, "/app/shortlist-feedback", "/shortlist-feedback", "/api/v1/starred-jobs", "/api/v1/feedback-events"]) {
        const input = { request: send(path), socketAddress };

        expect(server.capabilities(input)).toMatchObject({ canEditSettings: false, canRunRefresh: false });
        expect((yield* server.handle(input))?.status, path).toBe(403);
      }
    }

    const local = (request: Request) => server.handle({ request, socketAddress: "127.0.0.1" });
    const status = yield* local(send(localRunStatusPath));

    expect(status?.status).toBe(200);
    const { csrf_token } = yield* Effect.promise(() => status!.json());

    const start = (changes: Record<string, string>, socketAddress = "127.0.0.1") => server.handle({
      request: send(localRunStartPath, { origin: serveOrigin, "x-csrf-token": csrf_token, ...changes }, '{"confirm":true}'), socketAddress,
    });

    expect((yield* start({}, "192.0.2.44"))?.status).toBe(403);
    expect((yield* start({ "tailscale-user-login": serveOwner + ", " + serveOwner }))?.status).toBe(403);
    expect((yield* start({ "x-csrf-token": "" }))?.status).toBe(403);
    expect((yield* start({ origin: "http://" + serve.host }))?.status).toBe(403);
    expect(starts).toBe(0);
    expect((yield* start({}))?.status).toBe(202);
    expect(starts).toBe(1);
  }).pipe(Effect.provide(layer)));
});

test("hosted detection cannot downgrade login and invalid local bind fails without leaking credentials", async () => {
  for (const values of [
    new Map([["PULSE_DASHBOARD_MODE", "railway"]]),
    new Map([["PULSE_DASHBOARD_MODE", "local"], ["RAILWAY_PROJECT_ID", "invented"]]),
    new Map([["DIGEST_VIEW_USER", "invented"], ["DIGEST_VIEW_PASSWORD", "synthetic-password-0123456789"]]),
    new Map([["HOST", "0.0.0.0"]]),
    new Map([["ADDRESS_HEADER", "x-real-ip"]]),
    new Map([["ADDRESS_HEADER", " "]]),
    new Map([["SOCKET_PATH", "/synthetic/socket"]]),
  ]) {
    const result = await configResult(values);

    expect(Either.isLeft(result)).toBe(true);
    expect(String(result)).not.toContain("synthetic-password-0123456789");
  }

  const local = await configResult(new Map([["PULSE_DATA_DIR", "/synthetic/moved"], ["ADDRESS_HEADER", ""]]));

  expect(Either.isRight(local)).toBe(true);

  if (Either.isRight(local)) {
    expect(local.right.snapshotDb).toBe("/synthetic/moved/digests.sqlite");
    expect(local.right.feedbackDb).toBe("/synthetic/moved/shortlist-feedback.sqlite3");
    expect(local.right.login).toBeNull();
  }
});

test("local settings require explicit selection, and Railway markers ignore the selection", async () => {
  const localSettings = { root: "/synthetic/root", profileId: "invented" };
  const values = new Map([["PULSE_LOCAL_SETTINGS_ROOT", localSettings.root]]);

  expect(Either.isLeft(await configResult(values))).toBe(true);
  values.set("PULSE_LOCAL_SETTINGS_PROFILE", localSettings.profileId);
  expect(Either.getOrThrow(await configResult(values)).localSettings).toEqual(localSettings);
  values.set("RAILWAY_ENVIRONMENT_ID", "invented");
  values.set("DIGEST_VIEW_USER", "invented");
  values.set("DIGEST_VIEW_PASSWORD", "synthetic-password-0123456789");
  values.set("DIGEST_VIEW_SESSION_SECRET", "synthetic-session-secret-0123456789");
  expect(Either.getOrThrow(await configResult(values))).toMatchObject({ mode: "railway" });
  expect(Either.getOrThrow(await configResult(values)).localSettings).toBeUndefined();

  for (const [mode, socketAddress, changes] of [
    ["local", "127.0.0.1", {}], ["local", "192.0.2.5", { localSettings }], ["railway", "127.0.0.1", { localSettings }],
  ] as const) {
    await Effect.runPromise(Effect.gen(function* () {
      const server = yield* DashboardServer;
      expect(server.capabilities({ request: request("/app/"), socketAddress }).canEditSettings).toBe(false);

      for (const body of [undefined, "{}"]) {
        const denied = yield* server.handle({ request: request(localSettingsPath, body, { "x-forwarded-for": "127.0.0.1" }), socketAddress });
        expect(denied?.status).toBe(mode === "local" && socketAddress === "127.0.0.1" ? 403 : 404);
      }
    }).pipe(Effect.provide(services(mode, changes))));
  }
});

test("the editor requires the allowed host, same origin, token and bounded exact JSON", async () => {
  const root = "/synthetic/root";
  const profileId = "invented";
  const before = "a".repeat(64);
  const after = "b".repeat(64);
  const model = { harness: "pi", provider: "invented", model: "initial", effort: "medium" } as const;
  const steps = { screen: model, judge: model, rejudge: model, calibrate: model };
  const update = { ...model, kind: "model", revision: before, step: "judge", model: "next" };
  const probe = { ...update, kind: "test_model" };
  const refresh = { kind: "refresh_models" };

  let saves = 0;
  let probes = 0;
  let discoveries = 0;

  const editor = Layer.succeed(LocalProfileSettings, {
    read: (target) => Effect.sync(() => {
      expect(target).toEqual({ root, profileId });

      return {
        profile_id: profileId, models: { revision: before, steps, pi_catalog: null },
        filters: { revision: before, location: { home_postcode: '', radius_km: 25, place: null }, excluded_municipalities: [], excluded_title_terms: [], excluded_employers: [], allowed_occupation_categories: [] },
        judge: { revision: before, preferred_terms: [] }, screen: { revision: before, values: {}, advanced: {} },
        search_mode: { revision: before, mode: "passive" },
        schedule: { revision: before, expression: "weekly", anchor: null }, narrative: { revision: before, text: "Invented profile." },
      };
    }),
    save: (target, body) => Effect.sync(() => {
      expect(target).toEqual({ root, profileId });
      expect(body).toEqual(update);
      saves++;

      return { revision: after };
    }),
    refreshModels: () => Effect.sync(() => {
      discoveries++;

      return [];
    }),
    testModel: (_, body) => Effect.sync(() => { expect(body).toEqual(probe); probes++; }),
  });

  const layer = DashboardServerLive.pipe(
    Layer.provide(dashboardConfigTest({ ...settings("local"), localSettings: { root, profileId } })),
    Layer.provide(snapshot), Layer.provide(editor),
  );

  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const send = (request: Request) => server.handle({ request, socketAddress: "127.0.0.1" });
    const get = yield* send(request(localSettingsPath));
    expect(get?.status).toBe(200);
    expect(get?.headers.get("cache-control")).toBe("no-store");
    const current = Either.getOrThrow(decodeStrict(LocalSettingsDocument)(yield* Effect.promise(() => get!.json())));
    const headers = { origin: "http://viewer.synthetic.test", "x-csrf-token": current.csrf_token, "content-type": "application/json" };
    const post = (body: string, changes?: Record<string, string>) => send(request(localSettingsPath, body, { ...headers, ...changes }));
    expect((yield* send(new Request("http://external.invalid" + localSettingsPath, { headers: { host: "external.invalid" } })))?.status).toBe(403);
    expect((yield* post(JSON.stringify(update), { origin: "http://external.invalid" }))?.status).toBe(403);
    expect((yield* post(JSON.stringify(update), { "x-csrf-token": "c".repeat(64) }))?.status).toBe(403);
    expect((yield* post(JSON.stringify({ ...update, profile_id: "other" })))?.status).toBe(400);
    expect((yield* post(JSON.stringify(update), { "content-length": "262145" }))?.status).toBe(413);
    const filters = { kind: "location", revision: before, values: { home_postcode: "0123", radius_km: 0 } };

    for (const body of [
      filters,
      { ...filters, values: { radius_km: 25, home_postcode: "123" } },
      { ...filters, values: { radius_km: 25, home_postcode: "0123", origin_latitude: 0 } },
      { kind: "screen", revision: before, values: { version: "not editable" } },
      { kind: "judge", revision: before, values: [" "] },
      { kind: "schedule", revision: before, values: { expression: "weekly", anchor: 20261113 } },
      { kind: "search_mode", revision: before, values: "Actively looking" },
      { kind: "narrative", revision: before, values: "ø".repeat(50_001) },
      { kind: "narrative", revision: before, values: "Invented text.", path: "other.md" },
    ]) expect((yield* post(JSON.stringify(body)))?.status).toBe(400);

    expect(saves).toBe(0);
    const response = yield* post(JSON.stringify(update));
    expect(response?.status).toBe(200);
    expect(yield* Effect.promise(() => response!.json())).toEqual({ revision: after });
    expect(saves).toBe(1);
    expect(probes).toBe(0);
    expect(discoveries).toBe(0);

    for (const body of [probe, refresh]) {
      const data = JSON.stringify(body);
      expect((yield* post(data, { origin: "http://external.invalid" }))?.status).toBe(403);
      expect((yield* post(data, { "x-csrf-token": "" }))?.status).toBe(403);
      expect((yield* post(JSON.stringify({ ...body, prompt: "invented" })))?.status).toBe(400);
      expect((yield* server.handle({ request: request(localSettingsPath, data, headers), socketAddress: "192.0.2.1" }))?.status).toBe(404);
    }

    expect(probes).toBe(0);
    expect(discoveries).toBe(0);
    expect((yield* post(JSON.stringify(refresh)))?.status).toBe(200);
    const testReply = yield* post(JSON.stringify(probe));
    expect(testReply?.status).toBe(200);
    expect(yield* Effect.promise(() => testReply!.json())).toEqual({ ok: true });
    expect(probes).toBe(1);
    expect(discoveries).toBe(1);
    expect(saves).toBe(1);
  }).pipe(Effect.provide(layer)));
});

test("the frozen bearer capability requires all three valid settings and does not select the browser profile", async () => {
  const values = new Map([
    ["DIGEST_VIEW_STARRED_INSTANCE", "invented-instance"], ["DIGEST_VIEW_STARRED_PROFILE", "invented-profile"],
    ["DIGEST_VIEW_STARRED_TOKEN", "invented_token_".repeat(4)],
  ]);

  const token = values.get("DIGEST_VIEW_STARRED_TOKEN");

  for (const key of values.keys()) {
    const partial = new Map(values);
    partial.delete(key);

    expect(Either.isLeft(await configResult(partial))).toBe(true);
  }

  const enabled = await configResult(values);

  if (Either.isLeft(enabled)) throw new Error("Expected valid starred capability");
  expect(enabled.right.starred?.profileId).toBe("invented-profile");
  expect(enabled.right.feedbackProfile).toBeNull();
  expect(String(enabled.right.starred?.token)).not.toBe(token);

  values.set("DIGEST_VIEW_STARRED_TOKEN", "invalid");
  expect(Either.isLeft(await configResult(values))).toBe(true);
  expect(Either.isLeft(await configResult(new Map([["DIGEST_VIEW_FEEDBACK_PROFILE", "invalid--profile"]])))).toBe(true);
});

test("only a real local loopback socket bypasses login; forwarded headers and hosted loopback cannot", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;

    expect(yield* server.handle({ request: request("/app/"), socketAddress: "127.0.0.1" })).toBeUndefined();
    const denied = yield* server.handle({ request: request("/app/snapshot.json", undefined, { "x-real-ip": "127.0.0.1", "x-forwarded-for": "::1" }), socketAddress: "192.0.2.5" });

    expect(denied?.status).toBe(303);
    expect(denied?.headers.get("location")).toBe("/login?next=%2Fapp%2Fsnapshot.json");
  }).pipe(Effect.provide(services("local"))));

  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const denied = yield* server.handle({ request: request("/app/"), socketAddress: "127.0.0.1" });

    expect(denied?.status).toBe(303);
    expect(yield* server.handle({ request: request("/healthz"), socketAddress: "" })).toBeUndefined();

    const data = yield* server.handle({
      request: request("/app/__data.json?x-sveltekit-invalidated=01&view=recent"), socketAddress: "127.0.0.1", kitAppDataSearch: "?view=recent",
    });

    expect(data?.headers.get("location")).toBe("/login?next=%2Fapp%2F%3Fview%3Drecent");
  }).pipe(Effect.provide(services("railway"))));
});

test("signed local page-data responses retain feedback without settings or Run access", async () => {
  const cookie = "jmp_session=" + signSession(login!.sessionKey, 9_999_999_999);
  const localSettings = { root: "/synthetic/root", profileId: "invented" };

  const fixture = services("local", { localSettings, feedbackProfile: localSettings.profileId }).pipe(
    Layer.provide(Layer.succeed(DashboardRun, { start: () => Effect.dieMessage("Unexpected refresh start"), status: Effect.succeed(null), setClosing: () => Effect.dieMessage("Unexpected desktop close") })),
  );

  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;

    const input = {
      request: request("/app/__data.json", undefined, { cookie }), socketAddress: "192.0.2.44", kitAppDataSearch: "",
    };

    expect(yield* server.handle(input)).toBeUndefined();
    expect(server.capabilities(input)).toEqual({ canGiveFeedback: true, canEditSettings: false, canRunRefresh: false });
    expect(server.capabilities({ ...input, socketAddress: "127.0.0.1" })).toEqual({
      canGiveFeedback: true, canEditSettings: true, canRunRefresh: true,
    });
  }).pipe(Effect.provide(fixture)));
});

test("login uses a capped body and a secret-signed cookie; logout only clears the browser cookie", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;
    const tooLarge = yield* server.handle({ request: request("/login", "x", { "content-length": "4097" }), socketAddress: "192.0.2.5" });
    const duplicate = yield* server.handle({ request: request("/login", "x", { "content-length": "1, 1" }), socketAddress: "192.0.2.5" });

    expect(tooLarge?.status).toBe(413);
    expect(duplicate?.status).toBe(400);
    const result = yield* server.handle({ request: request("/login", "username=invented&password=synthetic-password-0123456789&next=%2Fapp%2F"), socketAddress: "192.0.2.5" });
    const cookie = result?.headers.get("set-cookie") ?? "";

    expect(result?.status).toBe(303);
    expect(result?.headers.get("location")).toBe("/app/");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
    expect(yield* server.handle({ request: request("/app/", undefined, { cookie: cookie.split(";")[0] ?? "" }), socketAddress: "192.0.2.5" })).toBeUndefined();
    const logout = yield* server.handle({ request: request("/logout", ""), socketAddress: "192.0.2.5" });

    expect(logout?.headers.get("set-cookie")).toBe("jmp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    expect(yield* server.handle({ request: request("/app/", undefined, { cookie: cookie.split(";")[0] ?? "" }), socketAddress: "192.0.2.5" })).toBeUndefined();
  }).pipe(Effect.provide(services("railway"))));
});

test("concurrent failures keep the one-second delay and cannot race past ten attempts", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;

    const attempts = yield* Effect.forEach(Array.from({ length: 11 }), () => Effect.fork(server.handle({
      request: request("/login", "username=wrong&password=wrong", { "x-real-ip": "192.0.2.7" }), socketAddress: "127.0.0.1",
    })));

    yield* TestClock.adjust("999 millis");
    const pending = yield* Effect.forEach(attempts, Fiber.poll);

    expect(pending.filter(Option.isNone)).toHaveLength(10);
    yield* TestClock.adjust("1 millis");
    const results = yield* Effect.forEach(attempts, Fiber.join);

    expect(results.filter((result) => result?.status === 401)).toHaveLength(10);
    expect(results.filter((result) => result?.status === 429)).toHaveLength(1);
  }).pipe(Effect.provide(services("railway"))));
});

test("received body caps and stalled-reader deadlines cancel streams instead of trusting a declared size", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;

    let cancelled = false;

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel() { cancelled = true; },
    });

    const init = { method: "POST", headers: { host: "viewer.synthetic.test", "content-length": "1" }, body: oversized, duplex: "half" };
    const result = yield* server.handle({ request: new Request("https://viewer.synthetic.test/login", init), socketAddress: "192.0.2.1" });

    expect(result?.status).toBe(413);
    expect(cancelled).toBe(true);
    let timedOut = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { timedOut = true; } });
    const stalledInit = { ...init, body: stalled };
    const attempt = yield* Effect.fork(server.handle({ request: new Request("https://viewer.synthetic.test/login", stalledInit), socketAddress: "192.0.2.1" }));

    yield* TestClock.adjust("5 seconds");
    expect((yield* Fiber.join(attempt))?.status).toBe(400);
    expect(timedOut).toBe(true);
  }).pipe(Effect.provide(services("railway"))));
});

test("ten failures consume one address window, not every visitor; a good password cannot bypass a full window", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const server = yield* DashboardServer;

    for (let index = 0; index < 10; index++) {
      const attempt = yield* Effect.fork(server.handle({ request: request("/login", "username=wrong&password=wrong", { "x-real-ip": "192.0.2.1" }), socketAddress: "127.0.0.1" }));

      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(attempt))?.status).toBe(401);
    }

    const goodBody = "username=invented&password=synthetic-password-0123456789";
    const denied = yield* server.handle({ request: request("/login", goodBody, { "x-real-ip": "192.0.2.1" }), socketAddress: "127.0.0.1" });
    const other = yield* server.handle({ request: request("/login", goodBody, { "x-real-ip": "192.0.2.2" }), socketAddress: "127.0.0.1" });

    expect(denied?.status).toBe(429);
    expect(other?.status).toBe(303);
    yield* TestClock.adjust("15 minutes");
    expect((yield* server.handle({ request: request("/login", goodBody, { "x-real-ip": "192.0.2.1" }), socketAddress: "127.0.0.1" }))?.status).toBe(303);
  }).pipe(Effect.provide(services("railway"))));
});
