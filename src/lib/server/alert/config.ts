import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { ProfileBundle } from "../../contracts/profile.ts";
import { AlertArtifacts } from "./artifacts.ts";
import { DISCORD_CHANNEL, endpoint, type DestinationConfig } from "./discord.ts";
import { AlertError } from "./errors.ts";

const bad = (code = "config_invalid") => new AlertError({ code });

const Config = Schema.Struct({ delivery: Schema.Struct({
  channel: Schema.optional(Schema.String), destination: Schema.optional(Schema.String), secret_env: Schema.optional(Schema.String),
}) });

export class AlertEnvironment extends Context.Tag("pulse/AlertEnvironment")<AlertEnvironment, {
  readonly destination: string | undefined; readonly channel: string | undefined; readonly secret: string | undefined;
}>() {}

export const AlertEnvironmentLive = Layer.sync(AlertEnvironment, () => ({
  destination: process.env.PULSE_DELIVERY_DESTINATION, channel: process.env.PULSE_DELIVERY_CHANNEL, secret: process.env.PULSE_DELIVERY_SECRET,
}));

export const checkProfile = (profile: ProfileBundle) => Effect.gen(function* () {
  const files = yield* AlertArtifacts;
  const directory = profile.paths.directory;

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/.test(profile.profile_id) || !isAbsolute(directory)
    || profile.paths.profile_id !== profile.profile_id || basename(directory) !== profile.profile_id
    || basename(dirname(directory)) !== "profiles" || basename(dirname(dirname(directory))) !== "local_only") return yield* bad("profile_invalid");
  yield* files.directory(resolve(directory)).pipe(Effect.mapError(() => bad("profile_invalid")));
});

export const destinationConfig = (profileId: string, destination: string, channel: string, source: DestinationConfig["source"]) => Effect.gen(function* () {
  if (channel !== DISCORD_CHANNEL) return yield* bad("unknown_channel");

  if (destination !== destination.trim() || !endpoint(destination)) return yield* bad();

  return { profile_id: profileId, destination: Redacted.make(destination), channel: DISCORD_CHANNEL, source } satisfies DestinationConfig;
});

export const loadDestinationConfig = (profile: ProfileBundle) => Effect.gen(function* () {
  yield* checkProfile(profile);
  const files = yield* AlertArtifacts;
  const env = yield* AlertEnvironment;
  const path = join(profile.paths.directory, "delivery.toml");
  const exists = yield* files.exists(path);

  if (env.destination !== undefined || env.channel !== undefined) {
    if (exists || env.destination === undefined || env.secret !== undefined) return yield* bad("config_sources_conflict");

    return yield* destinationConfig(profile.profile_id, env.destination, env.channel ?? "redacted_push", "environment");
  }

  if (env.secret !== undefined) return yield* bad("config_sources_conflict");

  if (!exists) return yield* bad("config_missing");
  const bytes = yield* files.read(path, 65536).pipe(Effect.mapError(() => bad()));
  const raw = yield* Effect.try({ try: () => parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), catch: () => bad() });
  const config = yield* Schema.decodeUnknown(Config, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(() => bad()));

  if (config.delivery.secret_env !== undefined || config.delivery.destination === undefined) return yield* bad();

  return yield* destinationConfig(profile.profile_id, config.delivery.destination, config.delivery.channel ?? "redacted_push", "local_only");
});
