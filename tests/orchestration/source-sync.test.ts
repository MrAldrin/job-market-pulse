import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Either, Layer } from "effect";
import { expect, test } from "vitest";
import { join } from "node:path";
import { Source, SourceLive } from "../../src/lib/server/source/service.ts";
import { AddressClient } from "../../src/lib/server/source/locations.ts";
import { ResolutionError } from "../../src/lib/server/source/errors.ts";
import { ORIGIN } from "../../src/lib/server/source/core.ts";
import { NavClient, NavClientReplay, type NavLimits, type NavReplayReply } from "../../src/lib/server/source/nav-client.ts";
import { acquireWorkflowLock, sourceLockPath, SourceWriterLockLive } from "../../src/lib/server/orchestration/workflow-locks.ts";
import type { FilterSourcePolicy } from "../../src/lib/contracts/source.ts";

const policy: FilterSourcePolicy = { rankMissing: () => [], locationCandidates: () => [], insideJobs: () => [] };
const id = (number: number) => `00000000-0000-0000-0000-${number.toString().padStart(12, "0")}`;
const page = (number: number) => `${ORIGIN}/api/v1/feed/${id(number)}`;

const check = <E>(replies: readonly NavReplayReply[], body: (path: string, limits: readonly (NavLimits | undefined)[]) => Effect.Effect<void, E, Source | FileSystem.FileSystem>) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-outer-source-" });
  const replay = NavClientReplay(replies);
  const limits: (NavLimits | undefined)[] = [];

  const clients = Layer.mergeAll(
    Layer.effect(NavClient, Effect.gen(function* () {
      const client = yield* NavClient;

      return { session: (selected?: NavLimits) => {
        limits.push(selected);

        return client.session(selected);
      } };
    })).pipe(Layer.provide(replay.layer)),
    Layer.succeed(AddressClient, { session: () => Effect.fail(new ResolutionError({ message: "Unexpected address request" })) }),
  );

  const services = SourceLive.pipe(Layer.provide(clients), Layer.provideMerge(SourceWriterLockLive), Layer.provideMerge(BunContext.layer));
  yield* body(join(root, "source.sqlite3"), limits).pipe(Effect.provide(services));
})).pipe(Effect.provide(BunContext.layer));

test("outer Source sync uses one retained bounded session and requires caught-up progress", async () => {
  await Effect.runPromise(check([{ url: ORIGIN + "/api/v1/feed?last", kind: "page", body: { id: id(1), items: [], next_url: null } }], (path, limits) => Effect.gen(function* () {
    const source = yield* Source;
    expect(yield* source.syncPipeline(path, policy)).toEqual({ events: 0, pages: 1, caught_up: true });
    expect(limits).toEqual([{ maxRequests: 100, seconds: 240 }]);
  })));

  const replies = Array.from({ length: 20 }, (_, index): NavReplayReply => ({
    url: index === 0 ? ORIGIN + "/api/v1/feed?last" : page(index + 1), kind: "page",
    body: { id: id(index + 1), items: [], next_url: page(index + 2) },
  }));

  await Effect.runPromise(check(replies, (path) => Effect.gen(function* () {
    const source = yield* Source;
    const result = yield* Effect.either(source.syncPipeline(path, policy));
    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) expect(result.left).toMatchObject({ transient: true, code: "source_not_caught_up" });
  })));
});

test("outer Source sync refuses busy writers and bad resolver limits before client work", async () => {
  await Effect.runPromise(check([], (path, limits) => Effect.scoped(Effect.gen(function* () {
    const source = yield* Source;
    yield* acquireWorkflowLock(yield* sourceLockPath(path));
    const busy = yield* Effect.either(source.syncPipeline(path, policy));
    expect(Either.isLeft(busy)).toBe(true);

    if (Either.isLeft(busy)) expect(busy.left.code).toBe("busy");
    const bad = yield* Effect.either(source.resolve(path, policy, { limit: 11 }));
    expect(Either.isLeft(bad)).toBe(true);
    expect(limits).toEqual([]);
  }))));
});
