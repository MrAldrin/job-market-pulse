import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
import type { ProfilePaths } from "../../contracts/profile.ts";
import { decodeProfileSettings, initialProfileConfig, pathsFor } from "./core.ts";
import { ProfileError } from "./errors.ts";
import { ProfileFiles } from "./files.ts";
import { decodeScreen } from "./settings.ts";

export class ProfileInitialization extends Context.Tag("pulse/ProfileInitialization")<ProfileInitialization, {
  readonly create: (root: string, id: string, explicitScreenRules: string) => Effect.Effect<ProfilePaths, ProfileError>;
}>() {}

// Local storage primitive only. The init CLI and interview/session controller remain B14.
export const ProfileInitializationLive = Layer.effect(ProfileInitialization, Effect.gen(function* () {
  const files = yield* ProfileFiles;

  return {
    create: (rawRoot: string, id: string, explicitScreenRules: string) => Effect.gen(function* () {
      const text = yield* initialProfileConfig(id);
      yield* decodeScreen(explicitScreenRules);
      const config = yield* decodeProfileSettings(text);
      const root = yield* files.root(rawRoot);
      const paths = yield* pathsFor(root, id, config);
      yield* files.directory(root, join(root, "local_only"));
      yield* files.directory(root, join(root, "local_only", "profiles"));
      yield* files.directory(root, paths.directory, true);
      const created: string[] = [];

      const contents = [
        [paths.profile_file, text],
        [paths.narrative_file, "<!-- Add this person's private narrative profile here. -->\n"],
        [join(paths.directory, "filters.toml"), "# Add this person's private filter settings here.\n# This placeholder is intentionally not ready to use.\n"],
        [join(paths.directory, "judge.toml"), "# Add this person's private Judge settings here.\n# This placeholder is intentionally not ready to use.\n"],
        [join(paths.directory, "screen.toml"), explicitScreenRules],
      ] as const;

      yield* Effect.gen(function* () {
        yield* files.directory(root, paths.outbox_dir, true);

        for (const [path, content] of contents) {
          yield* files.create(root, path, content);
          created.push(path);
        }
      }).pipe(Effect.onError(() => Effect.gen(function* () {
        for (const path of created.toReversed()) yield* files.remove(root, path);

        yield* files.removeDirectory(root, paths.outbox_dir);
        yield* files.removeDirectory(root, paths.directory);
      }).pipe(Effect.orDie)));

      return paths;
    }).pipe(Effect.uninterruptible),
  };
}));
