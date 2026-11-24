import { Config, Context, Effect, Layer } from "effect";

export class PulseConfig extends Context.Tag("pulse/Config")<PulseConfig, { readonly dataDir: string }>() {}

export const ConfigLive = Layer.effect(PulseConfig,
  Config.string("PULSE_DATA_DIR").pipe(
    Config.withDefault("data"),
    Config.validate({ message: "PULSE_DATA_DIR must not be empty", validation: (value) => value.length > 0 }),
    Effect.map((dataDir) => ({ dataDir })),
  ),
);

export const configTest = (dataDir: string) => Layer.succeed(PulseConfig, { dataDir });
