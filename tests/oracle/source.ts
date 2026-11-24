import { FileSystem } from "@effect/platform";
import { Clock, Duration, Effect, Layer, Predicate, Schema } from "effect";
import { join } from "node:path";
import { extractSalary } from "../../src/lib/server/market/salary.ts";
import { parseJsonInput, JsonInput } from "../../src/lib/server/shared/json-input.ts";
import { PythonFloat, type PythonJson, pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { sync } from "../../src/lib/server/source/ingestion.ts";
import { AddressClient, AddressClientLive, resolveCandidates, type ResolutionOptions } from "../../src/lib/server/source/locations.ts";
import { NavClient, NavClientReplay, SourceHttp } from "../../src/lib/server/source/nav-client.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore, type SourceSql } from "../../src/lib/server/source/store.ts";
import { sourceTopics } from "../../src/lib/server/source/topics.ts";

const now = "2026-10-19T12:00:00+00:00";

export type SourceBundle = "basic-run" | "changed-removed" | "market-history" | "resume-run" | "duplicate-alert" | "viewer-api";

const Reply = Schema.Struct({ url: Schema.String, kind: Schema.Literal("page", "detail"), body: Schema.NullOr(Schema.Record({ key: Schema.String, value: JsonInput })) });
const Batch = Schema.Struct({ details: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.Literal("detail"), body: Schema.NullOr(Schema.Record({ key: Schema.String, value: JsonInput })) })), addresses: Schema.Array(Schema.Struct({ url: Schema.String, body: JsonInput })) });

// Preserve external JSON float identity when passing recorded responses through HTTP.
const wireValue = (value: JsonInput): PythonJson => {
  if (Predicate.isNumber(value)) return new PythonFloat(value);

  if (Array.isArray(value)) return value.map(wireValue);

  if (Predicate.isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireValue(item)]));

  return value;
};

export const withReplayedSource = <A, E, R>(bundle: SourceBundle, use: (sql: SourceSql) => Effect.Effect<A, E, R>) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const input = ["resume-run", "duplicate-alert", "viewer-api"].includes(bundle) ? "basic-run" : bundle;
  const read = (name: string) => fs.readFileString(`tests/fixtures/port-oracle/${input}/inputs/${name}.json`).pipe(Effect.flatMap((text) => parseJsonInput(text)));
  const feed = yield* Schema.decodeUnknown(Schema.Struct({ runs: Schema.Array(Schema.Array(Reply)) }))(yield* read("source"));
  const resolver = yield* Schema.decodeUnknown(Schema.Struct({ runs: Schema.Array(Schema.Struct({ batches: Schema.Array(Batch) })) }))(yield* read("resolver"));
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-source-oracle-" });
  const sql = yield* acquireStore(join(directory, "source.sqlite3"), "create");
  // This replay compares logical output, not power-loss durability.
  yield* sql`PRAGMA synchronous=OFF`;
  yield* initializeSourceStorage(sql);
  // A scoped synthetic clock advances for address throttling without real sleeps.
  let millis = 0;

  const clock: Clock.Clock = { [Clock.ClockTypeId]: Clock.ClockTypeId, unsafeCurrentTimeMillis: () => millis,
    unsafeCurrentTimeNanos: () => BigInt(millis) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => millis), currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
    sleep: (duration) => Effect.sync(() => { millis += Duration.toMillis(duration); }) };

  yield* Effect.withClockScoped(clock);

  for (let run = 0; run < feed.runs.length; run++) {
    const replies = feed.runs[run]!;
    const replay = NavClientReplay(replies);
    yield* Effect.gen(function* () {
      const session = yield* (yield* NavClient).session();
      // The frozen FeedQueue has no detail counter; this is a replay-only override.
      session.details_remaining = replies.filter((reply) => reply.kind === "detail").length;
      yield* sync(sql, session, { salary: extractSalary, topics: sourceTopics }, { now });
      replay.assertConsumed();
    }).pipe(Effect.provide(replay.layer));
    const batches = resolver.runs[run]!.batches;
    // Staged Filter facts: recorded request IDs only, not evidence of admission.
    const candidates = [...new Set(batches.flatMap((batch) => batch.details.map((detail) => detail.path.split("/").at(-1)!)))].map((uuid) => ({ uuid }));
    let after: string | undefined;

    for (const batch of batches) {
      const nav = NavClientReplay(batch.details.map((detail) => ({ url: detail.path, kind: detail.kind, body: detail.body })));
      const addresses = [...batch.addresses];

      const http = Layer.succeed(SourceHttp, { request: (url) => Effect.sync(() => {
        const reply = addresses.shift();

        if (!reply || reply.url !== url) throw new Error(`Unexpected synthetic address request ${url}`);

        return { status: 200, headers: {}, bytes: new TextEncoder().encode(pythonJson(wireValue(reply.body))) };
      }) });

      const output = yield* Effect.gen(function* () {
        const client = yield* (yield* NavClient).session({ maxRequests: 10, seconds: 90 });
        const address = yield* (yield* AddressClient).session();
        const options: ResolutionOptions = after === undefined ? { now } : { now, after };

        const result = yield* resolveCandidates(sql, client, address, candidates, 10, options);
        nav.assertConsumed();

        if (addresses.length) throw new Error(`Unused synthetic address responses: ${addresses.length}`);

        return result;
      }).pipe(Effect.provide(nav.layer), Effect.provide(AddressClientLive.pipe(Layer.provide(http))));

      after = output.last_uuid ?? undefined;
    }
  }

  return yield* use(sql);
}));
