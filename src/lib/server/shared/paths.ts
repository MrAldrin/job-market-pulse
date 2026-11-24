import { FileSystem } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { isAbsolute, dirname, join, sep, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileError } from "../profile/errors.ts";
import { bundledResource, containsPath, installationSetting, installedPaths } from "./installation-paths.ts";

const notLink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));
const failure = () => new ProfileError({ message: "Cannot resolve filesystem path" });

// Source modules live in src/lib/server/<brick>; the Bun adapter puts their
// code in build/server/chunks. Neither location depends on the selected profile.
export const packageConfigPath = (moduleUrl: string, name: string): string => {
  const directory = dirname(fileURLToPath(moduleUrl));
  const built = directory.endsWith(sep + join("build", "server", "chunks"));

  return bundledResource(join(directory, built ? "../../.." : "../../../.."), join("config", name));
};

// Reject aliases and overlapping bundle/user trees only for the selected installed layout.
export const checkInstalledPath = (root: string, path: string) => Effect.gen(function* () {
  if (installedPaths?.data !== root) return;
  const resources = yield* physicalPath(installedPaths.resources);
  const overlaps = (directory: string) => containsPath(directory, resources) || containsPath(resources, directory);

  if (overlaps(installedPaths.data) || overlaps(installedPaths.config) || !(yield* isCanonicalPath(path))) {
    return yield* new ProfileError({ message: "Unsafe installed data or resource path" });
  }
});

export const checkedInstallationSetting = (root: string, name: string) => {
  const path = installationSetting(root, name);

  return checkInstalledPath(root, path).pipe(Effect.as(path));
};

// Only ROOT arguments call this adapter. Managed relative paths keep literal '~'.
export const expandProfileRoot = (path: string, home: string): Either.Either<string, ProfileError> => {
  const currentUser = path === "~" || path.startsWith("~/") || path.startsWith("~" + sep);

  if (path.startsWith("~") && !currentUser) return Either.left(new ProfileError({ message: "Named-user roots are not supported; pass an expanded absolute path" }));

  if (!currentUser) return Either.right(path);

  if (!isAbsolute(home)) return Either.left(new ProfileError({ message: "Cannot resolve current-user home for the selected root" }));

  return Either.right(home + path.slice(1));
};

// Python Path.resolve(strict=False): links resolve before later '..', and a
// dangling link retains its destination. Callers separately require a file/dir.
export const physicalPath = (path: string, platform: NodeJS.Platform = process.platform): Effect.Effect<string, ProfileError, FileSystem.FileSystem> => {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;

  const walk = (target: string, links: ReadonlySet<string>): Effect.Effect<string, ProfileError, FileSystem.FileSystem> => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = paths.parse(target).root;

    if (!paths.isAbsolute(target)) return yield* failure();

    let current = root;

    for (const part of target.slice(root.length).split(windows ? /[/\\]/ : "/")) {
      if (part === "" || part === ".") continue;

      if (part === "..") { current = paths.dirname(current); continue; }

      const candidate = paths.join(current, part);

      const link = yield* fs.readLink(candidate).pipe(
        Effect.catchTag("SystemError", (error) => error.reason === "NotFound" || notLink(error.cause)
          ? Effect.succeed(null) : Effect.fail(failure())),
        Effect.mapError(failure),
      );

      if (link !== null) {
        const key = windows ? candidate.toLowerCase() : candidate;

        if (links.has(key)) return yield* failure();

        current = yield* walk(paths.isAbsolute(link) ? link : current + paths.sep + link, new Set([...links, key]));
      } else if (windows) {
        // A non-link can still be an NTFS short-name alias. Use the filesystem
        // spelling for existing components and preserve missing suffixes.
        current = yield* fs.realPath(candidate).pipe(
          Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(candidate) : Effect.fail(error)),
          Effect.mapError(failure),
        );
      } else current = candidate;
    }

    return current;
  });

  return walk(path, new Set());
};

export const isCanonicalPath = (path: string, platform: NodeJS.Platform = process.platform) => physicalPath(path, platform).pipe(
  Effect.map((actual) => platform === "win32" ? actual.toLowerCase() === path.toLowerCase() : actual === path),
);
