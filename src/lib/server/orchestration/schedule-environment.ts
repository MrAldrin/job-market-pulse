import { Config, Effect, Option } from "effect";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ScheduleError } from "./schedule.ts";

export const userUnitDirectory = Effect.gen(function* () {
  const configured = yield* Config.option(Config.string("XDG_CONFIG_HOME"));

  const base = Option.isSome(configured)
    ? configured.value
    : join(yield* Effect.try({ try: homedir, catch: () => new ScheduleError({ message: "The user home directory is unavailable" }) }), ".config");

  if (!isAbsolute(base)) return yield* new ScheduleError({ message: "The user configuration directory must be absolute" });

  return join(base, "systemd", "user");
});

// This is preview argv, not command readiness. B14 registers the real refresh
// and scheduled command only after its upload/feedback services are composed.
export const scheduledCommand = (root: string, profileId: string): readonly string[] => [
  process.execPath, join(root, "src", "cli", "pulse.ts"), "--root", root, "--profile", profileId, "run-scheduled",
];
