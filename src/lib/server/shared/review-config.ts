import { FileSystem } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { isAbsolute, resolve, sep } from "node:path";
import { decodeStrict } from "../../contracts/support.ts";
import { ProfileError } from "../profile/errors.ts";
import { checkedInstallationSetting, physicalPath } from "./paths.ts";
import { strip } from "./text.ts";
import { parseToml } from "./toml.ts";

const Configuration = Schema.Struct({ feed_db: Schema.String });
const failure = () => new ProfileError({ message: "Cannot read local review configuration" });

export const decodeReviewConfig = (text: string): Either.Either<string, ProfileError> => Either.flatMap(parseToml(text), (raw) =>
  Either.flatMap(Either.mapLeft(decodeStrict(Configuration)(raw), failure), ({ feed_db }) =>
    // Path("") is "." in the frozen utility; keep that existing edge behavior.
    feed_db !== "" && strip(feed_db) === "" ? Either.left(failure()) : Either.right(feed_db),
  ),
);

export class ReviewConfiguration extends Context.Tag("pulse/ReviewConfiguration")<ReviewConfiguration, {
  readonly projectPath: (path: string) => Effect.Effect<string, ProfileError>;
  readonly selectedFeedDb: (explicit?: string) => Effect.Effect<string, ProfileError>;
}>() {}

export const reviewConfigurationLayer = (projectRoot: string) => Layer.effect(ReviewConfiguration, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const root = resolve(projectRoot);

  const projectPath = (path: string) => physicalPath(isAbsolute(path) ? path : root + sep + path).pipe(
    Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(failure),
  );

  return {
    projectPath,
    selectedFeedDb: (explicit?: string) => Effect.gen(function* () {
      if (explicit !== undefined) return yield* projectPath(explicit);

      const path = yield* checkedInstallationSetting(root, "local_only/review.toml").pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const exists = yield* fs.exists(path).pipe(Effect.mapError(failure));

      if (!exists) return yield* new ProfileError({ message: "Pass --db or set feed_db in ignored local_only/review.toml" });

      const bytes = yield* fs.readFile(path).pipe(Effect.mapError(failure));
      const text = yield* Either.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), catch: failure });

      return yield* projectPath(yield* decodeReviewConfig(text));
    }),
  };
}));
