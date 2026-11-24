import { ConfigProvider, Effect, Either } from "effect";
import { expect, it } from "vitest";
import { userUnitDirectory } from "../../src/lib/server/orchestration/schedule-environment.ts";

it("rejects relative and empty XDG configuration roots", async () => {
  for (const base of ["relative", ""]) {
    const result = await Effect.runPromise(Effect.either(userUnitDirectory).pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["XDG_CONFIG_HOME", base]]))),
    ));

    expect(Either.isLeft(result)).toBe(true);
  }
});
