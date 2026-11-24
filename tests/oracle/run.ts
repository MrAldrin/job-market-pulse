import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { AppLive } from "../../src/lib/server/runtime.ts";
import { compareAlertDigest } from "./alert.ts";
import { comparePhoneBoundaries } from "./phone-shortlist.ts";
import { compareDigestBoundaries } from "./select.ts";
import { compareSnapshotBoundaries } from "./snapshot.ts";

Effect.gen(function* () {
  yield* compareSnapshotBoundaries;
  yield* compareDigestBoundaries;
  yield* comparePhoneBoundaries;
  yield* compareAlertDigest;
  yield* Console.log("Oracle: snapshot JSON, CLI export, digest, shortlist and post-alert digest match the frozen outputs");
}).pipe(Effect.provide(AppLive), BunRuntime.runMain);
