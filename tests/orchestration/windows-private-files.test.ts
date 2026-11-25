import { FileSystem } from "@effect/platform";
import { BadArgument } from "@effect/platform/Error";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageNames } from "../../src/lib/server/orchestration/pipeline-core.ts";
import { runLockedPipeline } from "../../src/lib/server/orchestration/pipeline-runner.ts";
import { verifyWindowsPrivateDirectory, verifyWindowsPrivateFile, verifyWindowsPrivateSqlite, verifyWindowsWritableSqlite, windowsAclProbeArgv } from "../../src/lib/server/shared/windows-private-files.ts";
import { setWindowsFixturePublicRead } from "./windows-acl-fixture.ts";

const user = "S-1-5-21-123-456-789-1001";
const anotherUser = "S-1-5-21-123-456-789-1002";
const everyone = "S-1-1-0";
const directory = "C:\\Users\\Tester\\Pulse";
const path = `${directory}\\nested\\judge.sqlite3`;
const allow = (sid: string, mask: number, flags = 0) => ({ type: 0, flags, mask, sid });
const privateDir = { directory: true, owner: user, aces: [allow(user, 0x1f01ff, 3), allow("S-1-5-18", 0x1f01ff, 19)] };
const parent = { directory: true, owner: "S-1-5-32-544", aces: [allow(everyone, 0x1200a9), allow(everyone, 0x1f01ff, 11)] };
const database = { directory: false, owner: user, aces: [allow(user, 0x1f01ff)] };
const entries = [parent, parent, privateDir, privateDir, privateDir, database, null, null, null];

const verify = <A>(response: A) => Effect.runPromise(verifyWindowsPrivateSqlite(directory, path, () => Effect.succeed(response)));

test("checks the local path, its directory chain and every SQLite sidecar", async () => {
  const read = vi.fn(() => Effect.succeed({ user, entries }));
  await expect(Effect.runPromise(verifyWindowsPrivateSqlite(directory, path, read))).resolves.toEqual({ existed: true, missingParent: false, existingFiles: [path] });
  expect(read).toHaveBeenCalledWith([
    "C:\\", "C:\\Users", "C:\\Users\\Tester", directory, `${directory}\\nested`, path,
    `${path}-journal`, `${path}-wal`, `${path}-shm`,
  ]);
  await expect(verify({ user, entries: [...entries.slice(0, 4), null, null, null, null, null] })).resolves.toEqual({ existed: false, missingParent: true, existingFiles: [] });
});

test.each([
  ["an ancestor lets another user delete children", 1, { ...parent, aces: [allow(anotherUser, 0x40)] }],
  ["an ancestor gives another user generic write", 1, { ...parent, aces: [allow(anotherUser, 0x40000000)] }],
  ["another user owns the profile", 3, { ...privateDir, owner: anotherUser }],
  ["another user can read the profile", 3, { ...privateDir, aces: [...privateDir.aces, allow(anotherUser, 1)] }],
  ["another user would inherit an allow", 4, { ...privateDir, aces: [...privateDir.aces, allow(everyone, 1, 11)] }],
  ["the private owner ACE does not propagate", 4, { ...privateDir, aces: [allow(user, 0x1f01ff, 7)] }],
  ["a private directory has no inheritable ACL", 4, { ...privateDir, aces: [] }],
  ["the database is a directory", 5, privateDir],
  ["a journal has an unsafe ACL even with a deny ACE", 6, { ...database, aces: [{ ...allow(everyone, 1), type: 1 }, allow(everyone, 1)] }],
  ["a WAL has an unknown ACE", 7, { ...database, aces: [{ ...allow(user, 1), type: 5 }] }],
  ["a shared-memory file is public", 8, { ...database, aces: [allow(everyone, 1)] }],
])("refuses state when %s", async (_, index, bad) => {
  await expect(verify({ user, entries: entries.with(index, bad) })).rejects.toThrow("Cannot verify private Windows storage permissions");
});

test("refuses a missing selected profile, malformed output, and paths outside the profile without opening them", async () => {
  await expect(verify({ user, entries: entries.with(3, null) })).rejects.toThrow();
  await expect(verify({ user, entries: entries.slice(1) })).rejects.toThrow();
  await expect(verify({ user, entries: ["not an ACL"] })).rejects.toThrow();
  const read = vi.fn(() => Effect.succeed({ user, entries }));

  for (const unsafe of ["D:\\elsewhere\\judge.sqlite3", `${directory}2\\judge.sqlite3`, `${directory}\\data:stream`, `${directory}\\..\\judge.sqlite3`]) {
    await expect(Effect.runPromise(verifyWindowsPrivateSqlite(directory, unsafe, read))).rejects.toThrow();
  }

  expect(read).not.toHaveBeenCalled();
});

test("read-only existing state passes the privacy check but stops the pipeline before source", async () => {
  const read = () => Effect.succeed({ user, entries: entries.with(5, { ...database, aces: [allow(user, 1)] }) });
  const open = vi.fn(() => Effect.fail(new BadArgument({ module: "FileSystem", method: "open" })));
  const runStage = vi.fn(() => Effect.succeed({ returncode: 0, stdout: "", stderr: "" }));

  const program = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const preflight = verifyWindowsWritableSqlite(directory, path, read).pipe(Effect.match({
      onSuccess: () => ({ returncode: 0, stdout: "", stderr: "" }),
      onFailure: () => ({ returncode: 2, stdout: "", stderr: "Judge database access refused" }),
    }));

    return yield* runLockedPipeline({
      profileId: "test-profile", reviewerId: "judge", reset: false, once: true, newRunId: () => "a".repeat(32),
      preflight: () => preflight,
      stages: stageNames.map((name) => ({ name, timeoutMillis: 1000, run: runStage })),
      records: { read: Effect.succeed(null), write: () => Effect.void },
    }).pipe(Effect.provideService(FileSystem.FileSystem, { ...fs, open }));
  });

  await expect(Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)))).resolves.toMatchObject({ status: "failed", stage: null });
  expect(open).toHaveBeenCalledWith(path, { flag: "r+" });
  expect(runStage).not.toHaveBeenCalled();
});

test("refuses report directories that give another user access", async () => {
  const reply = [parent, parent, privateDir, privateDir];
  const read = (values: readonly (typeof privateDir)[]) => () => Effect.succeed({ user, entries: values });
  await expect(Effect.runPromise(verifyWindowsPrivateDirectory(directory, read(reply)))).resolves.toBeUndefined();
  await expect(Effect.runPromise(verifyWindowsPrivateDirectory(directory, read(reply.with(3, parent))))).rejects.toThrow();
});

test.runIf(process.platform === "win32")("native NTFS verification accepts a private fixture and rejects unsafe or missing storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pulse-native-acl-"));
  const nested = join(root, "synthetic 'ø' folder");
  const database = join(nested, "judge.sqlite3");
  const journal = `${database}-journal`;

  try {
    await mkdir(nested);
    await writeFile(database, "synthetic");
    await writeFile(journal, "synthetic");
    await expect(Effect.runPromise(verifyWindowsPrivateDirectory(root))).resolves.toBeUndefined();
    await expect(Effect.runPromise(verifyWindowsPrivateSqlite(root, database))).resolves.toMatchObject({ existed: true, existingFiles: [database, journal] });

    setWindowsFixturePublicRead(journal, true);
    await expect(Effect.runPromise(verifyWindowsPrivateSqlite(root, database))).rejects.toThrow("Cannot verify private Windows storage permissions");
    setWindowsFixturePublicRead(nested, true);
    await expect(Effect.runPromise(verifyWindowsPrivateFile(nested, database, true))).rejects.toThrow("Cannot verify private Windows storage permissions");
    await expect(Effect.runPromise(verifyWindowsPrivateDirectory(join(root, "missing")))).rejects.toThrow("Cannot verify private Windows storage permissions");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("uses a fixed non-interactive PowerShell script and refuses a relative or UNC system directory", () => {
  expect(windowsAclProbeArgv("C:\\Windows\\System32").slice(0, -1)).toEqual([
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  ]);
  expect(() => windowsAclProbeArgv("Windows")).toThrow();
  expect(() => windowsAclProbeArgv("\\\\host\\Windows")).toThrow();
});
