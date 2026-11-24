import { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeReviewConfig, ReviewConfiguration, reviewConfigurationLayer } from "../../src/lib/server/shared/review-config.ts";
import { run } from "../profile/fixtures.ts";

describe("explicit review source selection", () => {
  it.each(['unknown = "data/x"', 'feed_db = 1', 'feed_db = "   "', 'feed_db = "x"\nextra = true', 'not TOML'])('refuses invalid private configuration %s', (text) => {
    expect(Either.isLeft(decodeReviewConfig(text))).toBe(true);
  });
  it("uses the project root, not caller cwd, and explicit path bypasses config", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-review-" });
    const config = join(root, "local_only", "review.toml");
    yield* fs.makeDirectory(join(root, "local_only"));
    yield* fs.writeFile(config, new Uint8Array([255]));
    const service = yield* ReviewConfiguration.pipe(Effect.provide(reviewConfigurationLayer(root)));
    expect(yield* service.selectedFeedDb("data/explicit.sqlite3")).toBe(join(root, "data", "explicit.sqlite3"));
    expect(yield* service.projectPath("relative.sqlite3")).toBe(join(root, "relative.sqlite3"));
    expect(yield* service.projectPath(root + "/absolute.sqlite3")).toBe(root + "/absolute.sqlite3");
    expect(Either.isLeft(yield* Effect.either(service.selectedFeedDb()))).toBe(true);
    yield* fs.writeFileString(config, 'feed_db = "data/selected.sqlite3"');
    expect(yield* service.selectedFeedDb()).toBe(join(root, "data", "selected.sqlite3"));
    yield* fs.remove(config);
    const missing = yield* Effect.either(service.selectedFeedDb());
    expect(Either.isLeft(missing)).toBe(true);

    if (Either.isLeft(missing)) expect(missing.left.message).toBe("Pass --db or set feed_db in ignored local_only/review.toml");
  })));
  it("preserves Path empty-string behavior without treating spaces as a database", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-review-" });
    yield* fs.makeDirectory(join(root, "local_only"));
    yield* fs.writeFileString(join(root, "local_only", "review.toml"), 'feed_db = ""');
    const service = yield* ReviewConfiguration.pipe(Effect.provide(reviewConfigurationLayer(root)));
    expect(yield* service.selectedFeedDb()).toBe(root);
    expect(yield* service.selectedFeedDb("")).toBe(root);
  })));
  it("resolves symlinks before later parents and preserves dangling-link destinations", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-review-" });
    yield* fs.makeDirectory(join(root, "target", "deep"), { recursive: true });
    yield* fs.symlink(join(root, "target", "deep"), join(root, "link"));
    yield* fs.symlink("missing-directory/file.sqlite3", join(root, "dangling"));
    const service = yield* ReviewConfiguration.pipe(Effect.provide(reviewConfigurationLayer(root)));
    expect(yield* service.projectPath("link/../new.sqlite3")).toBe(join(root, "target", "new.sqlite3"));
    expect(yield* service.projectPath("dangling")).toBe(join(root, "missing-directory", "file.sqlite3"));
    yield* fs.symlink("cycle2", join(root, "cycle1"));
    yield* fs.symlink("cycle1", join(root, "cycle2"));
    expect(Either.isLeft(yield* Effect.either(service.projectPath("cycle1")))).toBe(true);
  })));
});
