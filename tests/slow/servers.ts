import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer, connect } from "node:net";
import { Effect, Either } from "effect";
import { decodeSnapshotBytes, type SnapshotV3, type SnapshotV4, type SnapshotV6 } from "../../src/lib/contracts/snapshot.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { snapshotJsonBytes } from "../../src/lib/server/snapshot/serialization.ts";
import { publishSnapshot } from "../../src/lib/server/snapshot/store.ts";
import { examplePersonalInputs, exampleRunFunnel, exampleSettings } from "../snapshot/settings-fixture.ts";
import { b8SnapshotBytes } from "./b8-fixture.ts";
import { feedbackAlias, feedbackOrigin, feedbackToken } from "./feedback-fixture.ts";
import { b8Origin, hostedSettingsOrigin, localSettingsOrigin, serveOrigin, serveOwner, serveProxy } from "./origins.ts";

// One foreground Playwright-owned harness. It builds once and owns every child.
// No inherited credentials, owner paths or agent assets enter the servers.
const root = await mkdtemp(join(tmpdir(), "pulse-browser-"));
const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NODE_ENV: "production" };
const children: ChildProcess[] = [];

const exitCode = (child: ChildProcess) => new Promise<number>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

let stopping = false;
let serve: ReturnType<typeof Bun.serve> | undefined;

const proxy = createServer((downstream) => {
  const upstream = connect({ host: "127.0.0.1", port: 4173, localAddress: "192.0.2.2" });

  downstream.pipe(upstream).pipe(downstream);
  upstream.on("error", () => downstream.destroy());
  downstream.on("error", () => upstream.destroy());
  downstream.on("close", () => upstream.destroy());
});

async function stop(): Promise<void> {
  if (stopping) return;

  stopping = true;
  proxy.close();
  await serve?.stop(true);

  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exitCode === null ? exitCode(child) : Promise.resolve(child.exitCode)));
  await rm(root, { recursive: true, force: true });
}

process.once("SIGTERM", () => { void stop().then(() => process.exit()); });

process.once("SIGINT", () => { void stop().then(() => process.exit()); });

try {
  const v1Path = resolve("contracts/fixtures/snapshot.example.json");
  const v2Path = join(root, "dashboard-b8-v2.json");
  const v3Path = join(root, "dashboard-settings-v3.json");
  const v6Path = join(root, "dashboard-refresh-v6.json");
  const feedbackDataDir = join(root, "local-feedback");
  const hostedSettingsDir = join(root, "hosted-settings");
  const editRoot = join(root, "settings-checkout");
  const editProfile = join(editRoot, "local_only", "profiles", "demo");
  const fakeBin = join(root, "fake-harnesses");
  const v1Bytes = await Bun.file(v1Path).bytes();
  const v3: SnapshotV3 = { ...Either.getOrThrow(decodeSnapshotBytes(v1Bytes)), schema_version: 3, settings: { ...exampleSettings, notifications_enabled: false } };

  const v4: SnapshotV4 = {
    ...v3, schema_version: 4, personal_inputs: examplePersonalInputs,
    profile: { ...v3.profile, mode: "active" },
    settings: { ...v3.settings, notifications_enabled: true, rejudge: { levels: ["exceptional", "poor"], same_as_judge: true } },
    jobs: v3.jobs.map((job, index) => index === 0 ? { ...job, rejudge: { first_fit: "poor", first_model: "invented/first", model: "invented/second" } } : job),
  };

  const distances = [10, 20, 25, null];

  const v6: SnapshotV6 = {
    ...v4, schema_version: 6, run_funnel: exampleRunFunnel,
    jobs: v4.jobs.map((job, index) => ({ ...job, distance_km: distances[index] ?? null })),
  };

  await mkdir(feedbackDataDir, { mode: 0o700 });
  await mkdir(hostedSettingsDir, { mode: 0o700 });
  await mkdir(join(root, "settings-data"), { mode: 0o700 });
  await Bun.write(v2Path, b8SnapshotBytes(v1Bytes));
  const poor = v3.jobs.find((job) => job.assessment.fit === "poor");

  if (!poor) throw new Error("Expected a poor-fit fixture job");
  await Bun.write(v3Path, snapshotJsonBytes({ ...v3, jobs: [...v3.jobs, {
    ...poor, id: "10000000-0000-4000-8000-000000000013", title: "Sales role at an invented boat show",
  }] }));
  await Bun.write(v6Path, snapshotJsonBytes(v6));
  await mkdir(editProfile, { recursive: true, mode: 0o700 });
  await mkdir(fakeBin, { mode: 0o700 });

  for (const harness of ["pi", "claude"]) {
    const path = join(fakeBin, harness);
    await Bun.write(path, `#!/bin/sh\nexec "${process.execPath}" "${resolve("tests/slow/settings-harness.ts")}" ${harness} "$@"\n`);
    await chmod(path, 0o700);
  }

  await Bun.write(join(editProfile, "profile.toml"), Either.getOrThrow(initialProfileConfig("demo")) + '\n[schedule]\nschedule = " weekly " # Invented schedule note\n');
  await Bun.write(join(editProfile, "filters.toml"), '[geography]\nradius_km = 30\nhome_postcode = "0123"\nhome_label = "Invented village"\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\n[jobs]\nexcluded_title_terms = ["old invented title"]\n');
  await Bun.write(join(editProfile, "screen.toml"), String.raw`version = "invented-v1"
academic = ['\bold\s+academic\w*', '\bengineer*\b']
`);
  await Bun.write(join(editProfile, "judge.toml"), '[jobs]\npreferred_terms = ["old preferred term"]\n');
  await Bun.write(join(editProfile, "profile.md"), 'An invented person likes making furniture.\n');
  await Bun.write(join(editRoot, "local_only", "models.toml"), Bun.file("tests/fixtures/port-oracle/basic-run/inputs/models.toml"));
  await Effect.runPromise(publishSnapshot(join(hostedSettingsDir, "digests.sqlite"), { html: new Uint8Array(), dashboardJson: snapshotJsonBytes(v4) }));
  const build = spawn(process.execPath, ["run", "build"], { env: environment, stdio: "inherit" });

  children.push(build);
  const built = await exitCode(build);

  if (built !== 0) throw new Error("Dashboard build failed");

  const login = {
    DIGEST_VIEW_USER: "invented", DIGEST_VIEW_PASSWORD: "synthetic-password-0123456789",
    DIGEST_VIEW_SESSION_SECRET: "synthetic-session-secret-0123456789",
  };

  const local = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, ...login, HOST: "127.0.0.1", PORT: "4173", ORIGIN: "http://localhost:4173",
    PULSE_DASHBOARD_MODE: "local", PULSE_DATA_DIR: join(root, "local"),
    PULSE_DASHBOARD_SNAPSHOT: v1Path,
    DIGEST_VIEW_ALLOWED_HOSTS: "127.0.0.1:4173,localhost:4173,127.0.0.1:4175",
  } });

  const hosted = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, ...login, HOST: "127.0.0.1", PORT: "4174", ORIGIN: "http://localhost:4174",
    PULSE_DASHBOARD_MODE: "railway", PULSE_DATA_DIR: join(root, "hosted"),
    DIGEST_VIEW_ALLOWED_HOSTS: "127.0.0.1:4174,localhost:4174",
  } });

  const b8 = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, HOST: "127.0.0.1", PORT: "4176", ORIGIN: b8Origin,
    PULSE_DASHBOARD_MODE: "local", PULSE_DATA_DIR: join(root, "local-b8"),
    PULSE_DASHBOARD_SNAPSHOT: v2Path, DIGEST_VIEW_FEEDBACK_PROFILE: "demo", DIGEST_VIEW_ALLOWED_HOSTS: new URL(b8Origin).host,
  } });

  const feedback = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, HOST: "127.0.0.1", PORT: "4177", ORIGIN: feedbackOrigin,
    PULSE_DASHBOARD_MODE: "local", PULSE_DATA_DIR: feedbackDataDir,
    PULSE_DASHBOARD_SNAPSHOT: v6Path, DIGEST_VIEW_ALLOWED_HOSTS: `${new URL(feedbackOrigin).host},${feedbackAlias}`,
    // The v6 fixture preserves profile.id from snapshot.example.json.
    DIGEST_VIEW_FEEDBACK_PROFILE: "demo", DIGEST_VIEW_STARRED_PROFILE: "demo",
    DIGEST_VIEW_STARRED_INSTANCE: "invented-loopback", DIGEST_VIEW_STARRED_TOKEN: feedbackToken,
  } });

  const hostedSettings = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, ...login, HOST: "127.0.0.1", PORT: new URL(hostedSettingsOrigin).port, ORIGIN: hostedSettingsOrigin,
    PULSE_DASHBOARD_MODE: "railway", PULSE_DATA_DIR: hostedSettingsDir,
    DIGEST_VIEW_ALLOWED_HOSTS: new URL(hostedSettingsOrigin).host,
    DIGEST_VIEW_FEEDBACK_PROFILE: "demo", DIGEST_VIEW_STARRED_PROFILE: "demo",
    DIGEST_VIEW_STARRED_INSTANCE: "invented-settings", DIGEST_VIEW_STARRED_TOKEN: feedbackToken,
    PULSE_LOCAL_SETTINGS_ROOT: editRoot, PULSE_LOCAL_SETTINGS_PROFILE: "demo",
  } });

  const localSettings = spawn(process.execPath, ["build/index.js"], { stdio: "inherit", env: {
    ...environment, PATH: fakeBin, HOST: "127.0.0.1", PORT: new URL(localSettingsOrigin).port,
    PULSE_DASHBOARD_SERVE_ORIGIN: serveOrigin, PULSE_DASHBOARD_SERVE_OWNER: serveOwner,
    PULSE_DASHBOARD_MODE: "local", PULSE_DASHBOARD_SNAPSHOT: v3Path, DIGEST_VIEW_ALLOWED_HOSTS: new URL(localSettingsOrigin).host,
    PULSE_DATA_DIR: join(root, "settings-data"), DIGEST_VIEW_FEEDBACK_PROFILE: "demo",
    DIGEST_VIEW_STARRED_PROFILE: "demo", DIGEST_VIEW_STARRED_INSTANCE: "invented-serve", DIGEST_VIEW_STARRED_TOKEN: feedbackToken,
    PULSE_LOCAL_SETTINGS_ROOT: editRoot, PULSE_LOCAL_SETTINGS_PROFILE: "demo",
  } });

  const servers = [local, hosted, b8, feedback, hostedSettings, localSettings];
  children.push(...servers);

  serve = Bun.serve({
    hostname: "127.0.0.1", port: Number(new URL(serveProxy).port),
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      const headers = new Headers(request.headers);
      const caller = headers.get("x-test-serve-caller");
      const protocol = headers.get("x-test-serve-protocol") ?? "https";
      headers.delete("x-test-serve-caller");
      headers.delete("x-test-serve-protocol");
      headers.delete("x-forwarded-proto");
      headers.delete("connection");

      for (const name of ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info"]) {
        headers.delete(name);
      }

      if (caller === "owner") headers.set("tailscale-user-login", serveOwner);

      if (caller === "other") headers.set("tailscale-user-login", "other@invented.test");

      if (protocol !== "missing") headers.set("x-forwarded-proto", protocol);

      headers.set("x-forwarded-for", "192.0.2.44");
      headers.set("x-forwarded-host", headers.get("host") ?? "");

      const options: RequestInit = { method: request.method, headers, redirect: "manual" };

      if (request.body !== null) options.body = await request.arrayBuffer();

      return fetch(localSettingsOrigin + pathname + search, options);
    },
  });

  if (process.env.PULSE_TEST_NONLOOPBACK === "1") proxy.listen(4175, "127.0.0.1");
  await Promise.race(servers.map(exitCode));
} finally {
  await stop();
}
