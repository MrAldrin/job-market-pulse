import { execFileSync } from "node:child_process";
import { ConfigProvider, Effect, Either, Layer } from "effect";
import { expect, test } from "vitest";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { ConfigLive, PulseConfig, configTest } from "../../src/lib/server/config.ts";
import { health } from "../../src/lib/server/health.ts";

test("the health service cannot expose the selected private data directory", async () => {
  const services = Layer.mergeAll(configTest("/synthetic/private"), FixedOsloClock);

  expect(await Effect.runPromise(health.pipe(Effect.provide(services)))).toEqual({ status: "ok" });
});

test("an empty PULSE_DATA_DIR must fail rather than select an unintended directory", async () => {
  const provider = Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["PULSE_DATA_DIR", ""]])));

  const result = await Effect.runPromise(Effect.either(PulseConfig.pipe(
    Effect.provide(ConfigLive.pipe(Layer.provide(provider))),
  )));

  expect(Either.isLeft(result)).toBe(true);
});

test("the CLI entry point must load and expose help without global installation", () => {
  const output = execFileSync("bun", ["src/cli/pulse.ts", "--help"], { encoding: "utf8" });

  expect(output).toContain("pulse");
  expect(output).toContain("--help");
  expect(output).toContain("refresh");
});
