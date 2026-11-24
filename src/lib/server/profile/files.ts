import { FileSystem } from "@effect/platform";
import { Context, Effect, Either, Layer, Option } from "effect";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { installedPaths, storageAnchor } from "../shared/installation-paths.ts";
import { checkInstalledPath, expandProfileRoot, isCanonicalPath, physicalPath } from "../shared/paths.ts";
import { verifyWindowsPrivateFile } from "../shared/windows-private-files.ts";
import { ProfileError } from "./errors.ts";

const privateFailure = () => new ProfileError({ message: "Cannot safely access private profile files" });

export class ProfileFiles extends Context.Tag("pulse/ProfileFiles")<ProfileFiles, {
  readonly root: (path: string) => Effect.Effect<string, ProfileError>;
  readonly check: (root: string, path: string, kind: "File" | "Directory") => Effect.Effect<boolean, ProfileError>;
  readonly read: (root: string, path: string, maximum?: number) => Effect.Effect<string, ProfileError>;
  readonly verifyPrivateFile: (root: string, path: string) => Effect.Effect<void, ProfileError>;
  readonly create: (root: string, path: string, content: string, requirePrivateAcl?: boolean) => Effect.Effect<void, ProfileError>;
  readonly remove: (root: string, path: string) => Effect.Effect<void, ProfileError>;
  readonly directory: (root: string, path: string, exclusive?: boolean) => Effect.Effect<void, ProfileError>;
  readonly removeDirectory: (root: string, path: string) => Effect.Effect<void, ProfileError>;
  readonly replace: (root: string, path: string, content: string, requirePrivateAcl?: boolean) => Effect.Effect<void, ProfileError>;
}>() {}

export const profileFilesLayer = (
  homeDirectory: Effect.Effect<string, ProfileError>,
  windowsPrivacy: typeof verifyWindowsPrivateFile | null = process.platform === "win32" ? verifyWindowsPrivateFile : null,
) => Layer.effect(ProfileFiles, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const inspect = (path: string) => fs.stat(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)),
  );

  const check = (root: string, path: string, kind: "File" | "Directory") => Effect.gen(function* () {
    const anchor = storageAnchor(root, path);
    const remainder = relative(anchor, path);

    if (isAbsolute(remainder) || remainder === ".." || remainder.startsWith(".." + sep)) {
      return yield* new ProfileError({ message: "Profile path escaped the project root" });
    }

    yield* checkInstalledPath(root, path).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    // Reject short-name and link aliases in a Windows checkout too. They can
    // bypass the separation between shared source and private profile data.
    if (process.platform === "win32" && root !== installedPaths?.data && !(yield* isCanonicalPath(path).pipe(Effect.provideService(FileSystem.FileSystem, fs)))) {
      return yield* privateFailure();
    }

    const info = yield* inspect(path);

    if (Option.isSome(info) && info.value.type !== kind) {
      return yield* new ProfileError({ message: "Profile path has the wrong file kind" });
    }

    let parent = dirname(path);

    while (parent !== anchor && parent !== dirname(parent)) {
      const metadata = yield* inspect(parent);

      if (Option.isSome(metadata) && metadata.value.type !== "Directory") {
        return yield* new ProfileError({ message: "Profile path parent must be a directory" });
      }

      parent = dirname(parent);
    }

    return Option.isSome(info);
  }).pipe(Effect.mapError((error) => error instanceof ProfileError ? error : privateFailure()));

  const privateAcl = (root: string, target: string, path: string, exists: boolean) => {
    const anchor = storageAnchor(root, target);

    return windowsPrivacy === null ? Effect.void : windowsPrivacy(anchor === root ? dirname(target) : anchor, path, exists).pipe(Effect.mapError(privateFailure));
  };

  const stage = (root: string, path: string, content: string, prefix: string, requirePrivateAcl: boolean) => Effect.gen(function* () {
    const temporary = yield* fs.makeTempFileScoped({ directory: dirname(path), prefix });

    if (requirePrivateAcl) yield* privateAcl(root, path, temporary, true);
    yield* fs.chmod(temporary, 0o600);
    yield* Effect.scoped(Effect.gen(function* () {
      const file = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
      yield* file.writeAll(new TextEncoder().encode(content));
      yield* file.sync;
    }));

    return temporary;
  });

  return {
    root: (path: string) => Effect.gen(function* () {
      const needHome = path === "~" || path.startsWith("~/") || path.startsWith("~" + sep);
      const home = needHome ? yield* homeDirectory : "/";
      const expanded = yield* expandProfileRoot(path, home);
      const absolute = isAbsolute(expanded) ? expanded : (yield* fs.realPath(".")) + sep + expanded;
      const root = yield* physicalPath(absolute).pipe(Effect.provideService(FileSystem.FileSystem, fs));

      if (absolute === installedPaths?.data && root !== absolute) return yield* privateFailure();
      const exists = yield* check(root, root, "Directory");

      if (!exists && root !== installedPaths?.data) return yield* new ProfileError({ message: "Project root must be an existing directory" });

      return root;
    }).pipe(Effect.mapError((error) => error instanceof ProfileError ? error : privateFailure())),

    check,
    read: (root: string, path: string, maximum = Number.MAX_SAFE_INTEGER) => Effect.gen(function* () {
      if (!(yield* check(root, path, "File"))) return yield* new ProfileError({ message: "Profile file is missing" });

      const file = yield* fs.open(path, { flag: "r" });
      const stat = yield* file.stat;

      if (stat.size > BigInt(maximum)) return yield* new ProfileError({ message: "Profile file exceeds bounds" });

      const chunks: Uint8Array[] = [];
      let size = 0;

      while (true) {
        const data = yield* file.readAlloc(Math.min(4096, maximum + 1 - size));

        if (Option.isNone(data)) break;

        size += data.value.byteLength;

        if (size > maximum) return yield* new ProfileError({ message: "Profile file exceeds bounds" });

        chunks.push(data.value);
      }

      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return yield* Either.try({
        // Python utf-8 retains BOM as text; hashing must preserve every source byte.
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        catch: privateFailure,
      });
    }).pipe(Effect.scoped, Effect.mapError((error) => error instanceof ProfileError ? error : privateFailure())),
    verifyPrivateFile: (root: string, path: string) => privateAcl(root, path, path, true),
    create: (root: string, path: string, content: string, requirePrivateAcl = false) => Effect.gen(function* () {
      if (yield* check(root, path, "File")) return yield* new ProfileError({ message: "Split settings already exist; nothing may be overwritten" });

      if (requirePrivateAcl) yield* privateAcl(root, path, path, false);

      const temporary = yield* stage(root, path, content, ".split-settings-", requirePrivateAcl);

      if (requirePrivateAcl) yield* privateAcl(root, path, path, false);
      // Hard-link creation is atomic and refuses an existing target, unlike rename.
      yield* fs.link(temporary, path);
    }).pipe(Effect.scoped, Effect.mapError(privateFailure)),
    directory: (root: string, path: string, exclusive = false) => Effect.gen(function* () {
      const exists = yield* check(root, path, "Directory");

      if (exists && exclusive) return yield* new ProfileError({ message: "Profile already exists" });

      const recursive = root === installedPaths?.data && (path === root || path === installedPaths.config);

      if (!exists) yield* fs.makeDirectory(path, { mode: 0o700, recursive });
    }).pipe(Effect.mapError(privateFailure)),
    removeDirectory: (root: string, path: string) => Effect.gen(function* () {
      if (!(yield* check(root, path, "Directory"))) return;

      if ((yield* fs.readDirectory(path)).length !== 0) return yield* privateFailure();

      // The platform remove API requires recursive=true even for an empty directory.
      yield* fs.remove(path, { recursive: true });
    }).pipe(Effect.mapError(privateFailure)),
    replace: (root: string, path: string, content: string, requirePrivateAcl = false) => Effect.gen(function* () {
      if (!(yield* check(root, path, "File"))) return yield* privateFailure();

      if (requirePrivateAcl) yield* privateAcl(root, path, path, true);

      const temporary = yield* stage(root, path, content, ".profile-mode-", requirePrivateAcl);
      yield* check(root, path, "File");

      if (requirePrivateAcl) yield* privateAcl(root, path, path, true);
      yield* fs.rename(temporary, path);

      // The POSIX directory fsync does not work with a Windows directory fd.
      if (requirePrivateAcl && windowsPrivacy !== null) return;
      const directory = yield* fs.open(dirname(path), { flag: "r" });
      yield* directory.sync;
    }).pipe(Effect.scoped, Effect.uninterruptible, Effect.mapError(privateFailure)),
    remove: (root: string, path: string) => check(root, path, "File").pipe(
      Effect.flatMap((exists) => exists ? fs.remove(path) : Effect.void),
      Effect.mapError(privateFailure),
    ),
  };
}));

export const ProfileFilesLive = profileFilesLayer(Effect.try({ try: homedir, catch: privateFailure }));
