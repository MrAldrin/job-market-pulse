import { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { osloDate, profilePeriod } from "../../src/lib/server/orchestration/schedule-profile.ts";
import { run, syntheticSplit } from "../profile/fixtures.ts";

const now = "2026-10-20T22:30:00+00:00";

describe("selected Profile schedule", () => {
  it("uses Oslo date, saved anchors and an explicit compact clock", async () => {
    await run(Effect.gen(function* () {
      const fixture = yield* syntheticSplit;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* osloDate(now)).toBe("2026-10-21");
      expect(yield* profilePeriod(fixture.root, "invented", { now })).toMatchObject({ kind: "weekly", time: "09:00", weekday: 4 });
      yield* fs.writeFileString(fixture.profileFile, fixture.config + '\n[schedule]\nschedule = "every 3 days 16:00"\nanchor = "2026-10-19"\n');
      expect(yield* profilePeriod(fixture.root, "invented", { now, requireAnchor: true })).toMatchObject({ kind: "every_n_days", n: 3, time: "16:00", anchor: "2026-10-19" });
      expect(yield* profilePeriod(fixture.root, "invented", { now, text: "weekly wed 1530" })).toMatchObject({ kind: "weekly", time: "15:30", weekday: 2, anchor: null });
    }));
  });

  it("does not move an unanchored interval during due checks or enable a disabled schedule", async () => {
    await run(Effect.gen(function* () {
      const fixture = yield* syntheticSplit;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(fixture.profileFile, fixture.config + '\n[schedule]\nschedule = "every 3 days"\n');
      expect(Either.isLeft(yield* Effect.either(profilePeriod(fixture.root, "invented", { now, requireAnchor: true })))).toBe(true);
      expect(yield* profilePeriod(fixture.root, "invented", { now })).toMatchObject({ anchor: "2026-10-21" });
      expect(yield* profilePeriod(fixture.root, "invented", { now, requireAnchor: true, anchor: "2026-10-18" })).toMatchObject({ anchor: "2026-10-18" });
      yield* fs.writeFileString(fixture.profileFile, fixture.config + '\n[schedule]\nschedule = "never"\n');
      expect(Either.isLeft(yield* Effect.either(profilePeriod(fixture.root, "invented", { now })))).toBe(true);
      expect(yield* profilePeriod(fixture.root, "invented", { now, text: "daily" })).toMatchObject({ kind: "daily" });
    }));
  });
});
