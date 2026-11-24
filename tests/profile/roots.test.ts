import { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileFiles, profileFilesLayer } from "../../src/lib/server/profile/files.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { expandProfileRoot } from "../../src/lib/server/shared/paths.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";
import { fixtureNarrative, run, syntheticSplit } from "./fixtures.ts";

describe("explicit Profile root expansion", () => {
  it("uses only the injected current-user home and preserves other relative strings", () => {
    expect(expandProfileRoot("~", "/synthetic/home")).toEqual(Either.right("/synthetic/home"));
    expect(expandProfileRoot("~/child", "/synthetic/home")).toEqual(Either.right("/synthetic/home/child"));
    expect(expandProfileRoot("./~named", "invalid-unused-home")).toEqual(Either.right("./~named"));
    expect(Either.isLeft(expandProfileRoot("~", "relative-home"))).toBe(true);
  });
  it("resolves current-user roots and symlinks before later dot-dot without a real home lookup", async () => run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b2-home-" });
    yield* fs.makeDirectory(join(home, "nested", "child"), { recursive: true });
    yield* fs.symlink(join(home, "nested", "child"), join(home, "link"));
    let homeReads = 0;

    const layer = profileFilesLayer(Effect.sync(() => { homeReads += 1;

 return home; }));

    yield* Effect.gen(function* () {
      const files = yield* ProfileFiles;
      expect(yield* files.root("~")).toBe(home);
      expect(yield* files.root("~/nested")).toBe(join(home, "nested"));
      expect(yield* files.root(join(home, "link") + "/..")).toBe(join(home, "nested"));
      expect(yield* files.root(home)).toBe(home);
    }).pipe(Effect.provide(layer));
    expect(homeReads).toBe(2);
  })));
  it("rejects named-user roots with a tagged clear error before home or filesystem access", async () => {
    let accesses = 0;

    const forbidden = () => { accesses += 1;

 return Effect.die("Unexpected external access"); };

    const fs = FileSystem.makeNoop({ realPath: forbidden, readLink: forbidden, stat: forbidden });

    const layer = profileFilesLayer(Effect.sync(() => { accesses += 1;

 return "/synthetic/home"; }));

    const result = await Effect.runPromise(Effect.gen(function* () {
      const files = yield* ProfileFiles;

      return yield* files.root("~invented-user/private").pipe(Effect.either);
    }).pipe(Effect.provide(layer), Effect.provideService(FileSystem.FileSystem, fs)));

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ProfileError");
      expect(result.left.message).toContain("pass an expanded absolute path");
    }

    expect(accesses).toBe(0);
  });
  it("does not expand or reject a literal tilde in a managed relative filename", async () => run(Effect.gen(function* () {
    const fixture = yield* syntheticSplit;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(fixture.profileFile, fixture.config.replace('profile = "profile.md"', 'profile = "~invented-user"'));
    const narrative = fixtureNarrative + "Prefers documented interfaces.\n";
    yield* fs.writeFileString(join(fixture.directory, "~invented-user"), narrative);
    const profile = yield* Profile;
    const loaded = yield* profile.load(fixture.root, "invented");
    expect(loaded.bundle.paths.narrative_file).toBe(join(fixture.directory, "~invented-user"));
    expect(loaded.settings.profile_fingerprint).toBe(sha256(narrative));
  })));
});
