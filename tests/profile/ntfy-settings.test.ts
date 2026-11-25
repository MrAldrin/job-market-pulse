import { syntheticServeOrigin } from "../shared/serve-hosts.ts";
import { FileSystem } from "@effect/platform";
import { Deferred, Effect, Either, Fiber, Layer } from "effect";
import { statSync } from "node:fs";
import { dirname, join, relative, sep, win32 } from "node:path";
import { expect, test, vi } from "vitest";
import { nativeDoctorHost } from "../../src/cli/doctor-host.ts";
import { planAlertSetup } from "../../src/cli/init-alerts.ts";
import { ntfyTransport, NtfyTransport } from "../../src/lib/server/alert/ntfy.ts";
import { DashboardNtfyTest, DashboardNtfyTestLive, localSettingsResponse } from "../../src/lib/server/dashboard/local-settings.ts";
import { localSettingsPath } from "../../src/lib/contracts/local-settings.ts";
import { isDashboardLink } from "../../src/lib/contracts/ntfy-settings.ts";
import { alertScheduledFailure } from "../../src/lib/server/orchestration/ntfy-notifications.ts";
import { profileFilesLayer } from "../../src/lib/server/profile/files.ts";
import { NtfySettingsError, ntfyEnabled, ntfySettingsPath, ntfySettingsView, readNtfySettings, saveNtfySettings } from "../../src/lib/server/profile/ntfy-settings.ts";
import { verifyWindowsPrivateFile } from "../../src/lib/server/shared/windows-private-files.ts";
import { run } from "./fixtures.ts";

const secretTopic = "invented-random-topic-01234567";
const link = "https://dashboard.example.test/app/";
const values = { enabled: true, topic: secretTopic, dashboard_url: link };

const fixture = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix: "pulse-ntfy-" }));

test("enable and disable share one private settings file; Doctor sees presence only", () => run(Effect.gen(function* () {
  const root = yield* fixture;
  const fs = yield* FileSystem.FileSystem;
  const probe = nativeDoctorHost(() => null).hasNtfyTopic(root);
  const read = readNtfySettings(root);
  const before = yield* read;
  expect(yield* probe).toBe(false);

  const revision = yield* saveNtfySettings(root, before.revision, values);
  expect(yield* fs.readFileString(ntfySettingsPath(root))).toContain(secretTopic);

  if (process.platform !== "win32") expect((yield* fs.stat(ntfySettingsPath(root))).mode & 0o777).toBe(0o600);
  expect(yield* probe).toBe(true);
  expect(yield* ntfyEnabled(root)).toBe(true);
  const after = yield* read;
  expect(JSON.stringify(after)).not.toContain(secretTopic);
  expect(ntfySettingsView(after)).toEqual({ dashboard_url: link, revision, enabled: true, topic_configured: true });

  const stale = yield* Effect.either(saveNtfySettings(root, before.revision, values));
  expect(Either.isLeft(stale) && stale.left.code).toBe("changed");
  yield* saveNtfySettings(root, revision, { ...values, enabled: false, topic: null });
  expect(yield* probe).toBe(true);
  expect(yield* ntfyEnabled(root)).toBe(false);

  yield* fs.remove(ntfySettingsPath(root));
  const alias = join(root, "other.toml");
  yield* fs.writeFileString(alias, `topic = "${secretTopic}"`);
  yield* fs.symlink(alias, ntfySettingsPath(root));
  expect(yield* probe).toBe(false);
  expect(yield* ntfyEnabled(root)).toBe(false);
  expect(Either.isLeft(yield* Effect.either(saveNtfySettings(root, before.revision, values)))).toBe(true);
})));

test("unsafe Windows ACLs stop saves and both immediate send paths before transport", () => run(Effect.gen(function* () {
  const root = yield* fixture;
  const fs = yield* FileSystem.FileSystem;
  const target = ntfySettingsPath(root);
  const directory = "C:\\Tester\\Pulse\\local_only";
  const user = "S-1-5-21-123-456-789-1001";
  const privateDir = { directory: true, owner: user, aces: [{ type: 0, flags: 3, mask: 0x1f01ff, sid: user }] };
  const privateFile = { ...privateDir, directory: false };
  const publicRead = { type: 0, flags: 0, mask: 1, sid: "S-1-1-0" };
  let access: "directory" | "staging" | "file" | "private" = "directory";

  const guardedFiles = profileFilesLayer(Effect.succeed(root), (boundary, path, exists) => {
    expect(boundary).toBe(dirname(target));
    const staged = path !== target;
    const windowsPath = win32.join(directory, ...relative(boundary, path).split(sep));
    const dir = access === "directory" ? { ...privateDir, aces: [{ ...privateDir.aces[0]!, flags: 7 }] } : privateDir;
    const unsafeFile = access === (staged ? "staging" : "file");
    const file = unsafeFile ? { ...privateFile, aces: [...privateFile.aces, publicRead] } : privateFile;

    if (staged) expect(statSync(path).size).toBe(0);

    return verifyWindowsPrivateFile(directory, windowsPath, exists, () => Effect.succeed({ user,
      entries: [privateDir, privateDir, privateDir, dir, ...(staged ? [privateDir] : []), exists ? file : null],
    }));
  });

  const post = vi.fn(() => Effect.succeed(true));
  const transport = Layer.succeed(NtfyTransport, { post });
  const dashboard = DashboardNtfyTestLive.pipe(Layer.provide(transport));

  yield* Effect.gen(function* () {
    const initial = yield* readNtfySettings(root);
    const save = (revision: string) => saveNtfySettings(root, revision, values);
    const refused = Either.left(new NtfySettingsError({ code: "unavailable" }));
    expect(yield* Effect.either(save(initial.revision))).toMatchObject(refused);
    expect(yield* fs.readDirectory(dirname(target))).toEqual([]);
    access = "staging";
    expect(yield* Effect.either(save(initial.revision))).toMatchObject(refused);
    expect(yield* fs.readDirectory(dirname(target))).toEqual([]);
    access = "private";
    const saved = yield* save(initial.revision);
    const original = yield* fs.readFileString(target);
    const dashboardSend = yield* DashboardNtfyTest;

    for (const unsafe of ["directory", "file"] as const) {
      access = unsafe;
      expect(yield* Effect.either(readNtfySettings(root))).toMatchObject(refused);
      const update = yield* Effect.either(saveNtfySettings(root, saved, { ...values, enabled: false }));
      expect(update).toMatchObject(refused);
      expect(JSON.stringify(update)).not.toContain(secretTopic);
      expect(JSON.stringify(update)).not.toContain(link);
      const response = yield* dashboardSend.send(root, saved);
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.text())).toBe("Notification settings unavailable.");
      yield* alertScheduledFailure(root).pipe(Effect.provide(transport));
      expect(post).not.toHaveBeenCalled();
      expect(yield* fs.readFileString(target)).toBe(original);
    }

    access = "private";
    expect((yield* dashboardSend.send(root, saved)).status).toBe(200);
    yield* alertScheduledFailure(root).pipe(Effect.provide(transport));
    expect(post).toHaveBeenCalledTimes(2);
    yield* saveNtfySettings(root, saved, { ...values, enabled: false });
    expect(yield* ntfyEnabled(root)).toBe(false);
  }).pipe(Effect.provide(dashboard), Effect.provide(guardedFiles));
})));

test("outbound link must be HTTPS without user info, queries or fragments", () => {
  expect(isDashboardLink(link)).toBe(true);

  for (const url of ["http://example.test/", "https://user:pass@example.test/", "https://@example.test/", "https://example.test/?", "https://example.test/#", "https:///example.test/", "https://a\t.example.test/", "https://example.test/\u0000"]) {
    expect(isDashboardLink(url)).toBe(false);
  }
});

test("init uses a separate secret prompt, never saves a recovery answer and needs confirmation", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fixture;
  const output: string[] = [];
  const request = { root, dryRun: false, nonInteractive: false, resume: false };

  const setup = (save: string, dryRun = false) => {
    const answers = ["yes", link, save];
    const say = (text: string) => Effect.sync(() => { output.push(text); });
    const ask = (prompt: string) => say(prompt).pipe(Effect.map(() => answers.shift() ?? ""));
    const askSecret = (prompt: string) => say(prompt).pipe(Effect.as(secretTopic));

    return planAlertSetup({ ...request, dryRun }, { say, ask }, askSecret);
  };

  expect(yield* setup("yes", true)).toBe(0);
  expect(yield* setup("no")).toBe(0);
  expect(yield* fs.exists(ntfySettingsPath(root))).toBe(false);
  expect(yield* setup("yes")).toBe(0);
  expect(yield* ntfyEnabled(root)).toBe(true);
  expect(yield* fs.readDirectory(join(root, "local_only"))).toEqual(["ntfy.toml"]);
  expect(output.join("\n")).not.toContain(secretTopic);
})));

test.each(["http", "https"] as const)("dashboard Send test on %s checks CSRF and saved revision and uses a fake sender", (scheme) => run(Effect.gen(function* () {
  const root = yield* fixture;
  const { revision } = yield* readNtfySettings(root);
  const saved = yield* saveNtfySettings(root, revision, values);
  const calls: string[] = [];

  const posting = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();

  const transport = ntfyTransport(async (_url, init) => {
    calls.push(String(init.body));
    await Effect.runPromise(Deferred.succeed(posting, undefined).pipe(Effect.zipRight(Deferred.await(resume))));

    return new Response(secretTopic);
  });

  const layer = DashboardNtfyTestLive.pipe(Layer.provide(Layer.succeed(NtfyTransport, transport)));

  yield* Effect.gen(function* () {
    const testSend = yield* DashboardNtfyTest;
    const noSettings = () => Effect.dieMessage("Unexpected editor operation");
    const settings = { read: noSettings, save: noSettings, testModel: noSettings, refreshModels: noSettings };
    const csrf = "a".repeat(64);
    const url = new URL(localSettingsPath, scheme === "http" ? "http://localhost:4173" : syntheticServeOrigin);

    const send = (selectedRevision: string, token = csrf, origin = url.origin) => {
      const body = JSON.stringify({ kind: "test_notification", revision: selectedRevision });

      const request = new Request(url, { method: "POST", body, headers: {
        host: url.host, origin, "content-type": "application/json", "content-length": String(body.length), "x-csrf-token": token,
      } });

      return localSettingsResponse(request, url, { root, profileId: "invented" }, csrf, scheme, settings, testSend);
    };

    expect((yield* send(saved, "wrong")).status).toBe(403);
    expect((yield* send(saved, csrf, "http://elsewhere.example.test")).status).toBe(403);
    expect((yield* send(revision)).status).toBe(409);
    expect(calls).toEqual([]);
    const pending = yield* Effect.fork(send(saved));
    yield* Deferred.await(posting);
    const replacement = { ...values, topic: "invented-replacement-topic-01234" };
    const busy = yield* Effect.either(saveNtfySettings(root, saved, replacement));
    expect(Either.isLeft(busy) && busy.left.code).toBe("busy");
    expect((yield* send(saved)).status).toBe(409);
    yield* Deferred.succeed(resume, undefined);
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(200);
    yield* saveNtfySettings(root, saved, replacement);
    expect((yield* send(saved)).status).toBe(409);
    expect(yield* Effect.promise(() => response.text())).toBe('{"ok":true}');
    expect(calls.map((body) => JSON.parse(body))).toEqual([{
      topic: secretTopic, title: "Job Market Pulse: test notification", message: "This is a test from local settings.",
    }]);
  }).pipe(Effect.provide(layer));
})));
