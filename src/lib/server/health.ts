import { Effect } from "effect";
import { osloNow } from "./clock.ts";
import { PulseConfig } from "./config.ts";

export const health = Effect.gen(function* () {
  yield* PulseConfig;
  yield* osloNow;

  return { status: "ok" } as const;
});
