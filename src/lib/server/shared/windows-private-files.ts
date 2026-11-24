import { FileSystem } from "@effect/platform";
import { Data, Effect, Schema } from "effect";
import { win32 } from "node:path";
import { unsafeWindowsSegment } from "../profile/core.ts";

class WindowsPrivacyError extends Data.TaggedError("WindowsPrivacyError")<{ readonly message: string }> {}

const denied = () => new WindowsPrivacyError({ message: "Cannot verify private Windows storage permissions" });

const localPath = (value: string) => /^[a-z]:\\/iu.test(value) && win32.normalize(value) === value &&
  !value.slice(3).split("\\").some(unsafeWindowsSegment);

const facts = Schema.is(Schema.Struct({
  user: Schema.String.pipe(Schema.pattern(/^S-1-(?:\d+-)*\d+$/u)),
  entries: Schema.Array(Schema.NullOr(Schema.Struct({
    directory: Schema.Boolean, owner: Schema.String,
    aces: Schema.Array(Schema.Struct({ type: Schema.Int, flags: Schema.Int, mask: Schema.Int, sid: Schema.String })),
  }))),
}));

// Use raw ACEs, not a formatted ACL or a localized command transcript. The
// input is data in an environment variable, never PowerShell source or argv.
const probeScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $paths = ConvertFrom-Json -InputObject $env:PULSE_ACL_PATHS
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($paths[0]))
  if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { exit 1 }
  $entries = [Collections.Generic.List[object]]::new()
  foreach ($path in $paths) {
    try { $attributes = [IO.File]::GetAttributes($path) }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $entries.Add($null); continue }
    if ($attributes -band 1088) { exit 1 } # ReparsePoint or Device
    $directory = ($attributes -band 16) -ne 0
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($path) }
    else { $acl = [IO.File]::GetAccessControl($path) }
    $sd = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if (($sd.ControlFlags -band 4) -eq 0 -or $null -eq $sd.DiscretionaryAcl -or $null -eq $sd.Owner) { exit 1 }
    $aces = @(foreach ($ace in $sd.DiscretionaryAcl) {
      if ([int]$ace.AceType -notin (0, 1)) { exit 1 }
      @{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; mask = $ace.AccessMask; sid = $ace.SecurityIdentifier.Value }
    })
    $entries.Add(@{ directory = $directory; owner = $sd.Owner.Value; aces = $aces })
  }
  @{ user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries = $entries.ToArray() } | ConvertTo-Json -Compress -Depth 6
} catch { exit 1 }
`;

const systemDirectory = (): string => {
  if (process.arch !== "x64") throw denied();

  // SAFETY: Windows GetSystemDirectoryW takes a writable WCHAR buffer and
  // its character capacity. The result length excludes the terminating NUL.
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const buffer = Buffer.alloc(520);

  const library = dlopen("kernel32.dll", {
    GetSystemDirectoryW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });

  try {
    const length = library.symbols.GetSystemDirectoryW(buffer, buffer.length / 2);

    if (length === 0 || length >= buffer.length / 2) throw denied();

    return buffer.toString("utf16le", 0, length * 2);
  } finally {
    library.close();
  }
};

export const windowsAclProbeArgv = (systemDir: string): readonly [string, ...string[]] => {
  if (!localPath(systemDir)) throw denied();

  return [win32.join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(probeScript, "utf16le").toString("base64")];
};

type ReadAcl = (paths: readonly string[]) => Effect.Effect<unknown, WindowsPrivacyError>;

const readAcl: ReadAcl = (paths) => Effect.tryPromise({
  try: async (signal) => {
    const systemDir = systemDirectory();
    const [exe, ...args] = windowsAclProbeArgv(systemDir);
    const cwd = win32.dirname(exe);

    const child = Bun.spawn([exe, ...args], {
      cwd, env: { SystemRoot: win32.dirname(systemDir), PSModulePath: win32.join(cwd, "Modules"), PULSE_ACL_PATHS: JSON.stringify(paths) },
      stdin: "ignore", stderr: "ignore", stdout: "pipe", windowsHide: true, timeout: 10_000, signal,
    });

    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    if (code !== 0) throw denied();

    const value: unknown = JSON.parse(text);

    return value;
  },
  catch: denied,
});

// Readers must check the same SQLite siblings as writers. A journal can be
// opened or recovered during acquisition. New siblings must inherit a private ACL.
const sidecars = ["-journal", "-wal", "-shm"];
const replaceRights = 0x500d0150; // Generic write/all, delete/child, change owner/DACL, write attributes/EA.
const fullControl = 0x001f01ff;

const inspectWindowsPaths = (directory: string, leafDirectory: string, files: readonly string[], read: ReadAcl) => Effect.gen(function* () {
  const parents: string[] = [];
  let current = leafDirectory;

  for (;;) {
    parents.unshift(current);
    const parent = win32.dirname(current);

    if (parent === current) break;
    current = parent;
  }

  const boundary = parents.indexOf(directory);

  if (boundary < 0) return yield* denied();
  const report = yield* read([...parents, ...files]);

  if (!facts(report) || report.entries.length !== parents.length + files.length) return yield* denied();
  // Current user, SYSTEM, administrators and Windows TrustedInstaller.
  const trusted = new Set([report.user, "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
  let missingParent = false;

  for (const [index, entry] of report.entries.entries()) {
    const isDirectory = index < parents.length;
    const privateEntry = index >= boundary;

    if (entry === null) {
      // The profile must already exist and be private. We may create only
      // below this boundary, where children inherit trusted permissions.
      if (index <= boundary) return yield* denied();

      if (isDirectory) missingParent = true;

      continue;
    }

    if (missingParent || entry.directory !== isDirectory || !trusted.has(entry.owner)) return yield* denied();
    let inheritable = false;

    for (const ace of entry.aces) {
      if ((ace.type !== 0 && ace.type !== 1) || (ace.flags & ~31) !== 0) return yield* denied();

      if (ace.type === 1) {
        // A deny on a private directory makes effective creation rights uncertain.
        if (privateEntry && isDirectory) return yield* denied();

        continue; // Never rely on a deny ACE to cancel an allow.
      }

      if (!trusted.has(ace.sid)) {
        if (privateEntry || (!(ace.flags & 8) && (ace.mask & replaceRights))) return yield* denied();
      } else if (ace.sid === report.user && (ace.flags & 15) === 3 && (ace.mask & fullControl) === fullControl) inheritable = true;
    }

    if (privateEntry && isDirectory && !inheritable) return yield* denied();
  }

  return {
    existed: files.length > 0 && report.entries[parents.length] !== null, missingParent,
    existingFiles: files.filter((_, index) => report.entries[parents.length + index] !== null),
  };
});

export const verifyWindowsPrivateDirectory = (directory: string, read: ReadAcl = readAcl) => Effect.suspend(() => localPath(directory)
  ? inspectWindowsPaths(directory, directory, [], read).pipe(Effect.asVoid) : Effect.fail(denied()));

export const verifyWindowsPrivateFile = (directory: string, path: string, exists: boolean, read: ReadAcl = readAcl) => Effect.gen(function* () {
  if (!localPath(directory) || !localPath(path)) return yield* denied();
  const relative = win32.relative(directory, path);

  if (!relative || win32.isAbsolute(relative) || relative === ".." || relative.startsWith("..\\")) return yield* denied();
  const state = yield* inspectWindowsPaths(directory, win32.dirname(path), [path], read);

  if (state.missingParent || state.existed !== exists) return yield* denied();
});

export const verifyWindowsPrivateSqlite = (directory: string, path: string, read: ReadAcl = readAcl) => Effect.gen(function* () {
  if (!localPath(directory) || !localPath(path)) return yield* denied();
  const relative = win32.relative(directory, path);

  if (!relative || win32.isAbsolute(relative) || relative === ".." || relative.startsWith("..\\")) return yield* denied();

  return yield* inspectWindowsPaths(directory, win32.dirname(path), [path, ...sidecars.map((suffix) => path + suffix)], read);
});

// Writable admission uses the current token and real file access. The DACL
// alone does not detect read-only files, deny ACEs or sharing conflicts.
export const verifyWindowsWritableSqlite = (directory: string, path: string, read: ReadAcl = readAcl) => Effect.gen(function* () {
  const state = yield* verifyWindowsPrivateSqlite(directory, path, read);
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.forEach(state.existingFiles, (file) => Effect.scoped(fs.open(file, { flag: "r+" })).pipe(
    Effect.mapError(denied),
  ), { discard: true });
});
