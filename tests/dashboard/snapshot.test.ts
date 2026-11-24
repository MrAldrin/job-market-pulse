import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// Vitest runs in Node; the accepted SnapshotStore uses Bun's native SQLite driver.
const run = (body: string) => {
  const result = spawnSync("bun", ["--eval", `
    import { strict as assert } from "node:assert";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    import { FileSystem } from "@effect/platform";
    import { BunContext } from "@effect/platform-bun";
    import { Effect, Either, Layer } from "effect";
    import { dashboardConfigTest } from "./src/lib/server/dashboard/config.ts";
    import { APP_CSP } from "./src/lib/server/dashboard/response.ts";
    import { DashboardSnapshot, DashboardSnapshotLive, dashboardSnapshotResponse } from "./src/lib/server/dashboard/snapshot.ts";
    import { SnapshotStore, SnapshotStoreLive } from "./src/lib/server/snapshot/store.ts";
    import { SnapshotJsonFileLive } from "./src/lib/server/snapshot/json-file.ts";
    import { SnapshotPathsLive } from "./src/lib/server/snapshot/paths.ts";

    const jsonFile = SnapshotJsonFileLive.pipe(Layer.provide(SnapshotPathsLive));
    const encoder = new TextEncoder();
    const html = encoder.encode("<article>Synthetic shortlist</article>");
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-dashboard-snapshot-" });
      const snapshotDb = join(dataDir, "digests.sqlite");
      const fixture = yield* fs.readFileString("tests/oracle/viewer-api/snapshot/snapshot-v1.json");
      const config = (snapshotFile = null, localSettings) => dashboardConfigTest({
        localSettings,
        mode: "local", port: 8770, allowedHosts: ["127.0.0.1:8770"], login: null,
        dataDir, snapshotFile, snapshotDb, feedbackDb: join(dataDir, "shortlist-feedback.sqlite3"), feedbackProfile: null, starred: null,
      });
      const dashboard = (effect, snapshotFile, localSettings) => effect.pipe(Effect.provide(DashboardSnapshotLive.pipe(
        Layer.provide(config(snapshotFile, localSettings)), Layer.provide(jsonFile), Layer.provide(SnapshotStoreLive),
      )));
      const store = yield* SnapshotStore;
      const readDocument = Effect.flatMap(DashboardSnapshot, (service) => service.readDocument);
      ${body}
    });
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(SnapshotStoreLive), Effect.provide(BunContext.layer)));
  `], { encoding: "utf8", timeout: 20_000 });

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
};

test("Dashboard Snapshot reads the newest SQLite row and serves its original bytes on GET", () => run(`
  const previous = "2026-10-18T12:00:00+00:00";
  const publishedAt = "2026-10-19T12:00:00+00:00";
  const olderDocument = fixture.replace(publishedAt, previous);
  yield* store.publish(snapshotDb, { html, dashboardJson: encoder.encode(olderDocument), publishedAt: previous });
  const dashboardJson = encoder.encode(fixture + "\\n");
  yield* store.publish(snapshotDb, { html, dashboardJson, publishedAt });

  const document = yield* dashboard(readDocument);
  assert.equal(document?.schema_version, 1);
  assert.equal(document?.generated_at, publishedAt);
  const get = yield* dashboard(dashboardSnapshotResponse(false));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("x-digest-published"), publishedAt);
  assert.equal(get.headers.get("content-security-policy"), APP_CSP);
  assert.deepEqual(new Uint8Array(yield* Effect.promise(() => get.arrayBuffer())), dashboardJson);

  const head = yield* dashboard(dashboardSnapshotResponse(true));
  assert.equal(head.status, get.status);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(head.body, null);
`));

test("Dashboard Snapshot returns 404 for missing JSON and 503 for a damaged saved document", () => run(`
  const get = dashboard(dashboardSnapshotResponse(false));
  assert.equal((yield* get).status, 404);
  assert.equal(yield* fs.exists(snapshotDb), false);
  yield* store.publish(snapshotDb, { html });
  assert.equal((yield* get).status, 404);

  const database = new Database(snapshotDb);
  try {
    database.query("UPDATE digest_snapshots SET dashboard_json = ?").run(encoder.encode('{"schema_version":1'));
  } finally {
    database.close();
  }
  const damaged = yield* get;
  assert.equal(damaged.status, 503);
  assert.equal(damaged.headers.has("x-digest-published"), false);
  const body = yield* Effect.promise(() => damaged.text());
  assert(!body.includes(snapshotDb));
`));

test("Dashboard Snapshot reads the first selected snapshot without a server restart", () => run(`
  const path = join(dataDir, "snapshot.json");
  const document = JSON.parse(fixture);
  const get = dashboard(dashboardSnapshotResponse(false), path, { root: dataDir, profileId: document.profile.id });
  assert.equal((yield* get).status, 404);
  assert.equal((yield* dashboard(dashboardSnapshotResponse(false), path)).status, 503);
  yield* fs.writeFileString(path, fixture);
  assert.equal((yield* get).status, 200);
  yield* fs.writeFileString(path, JSON.stringify({ ...document, profile: { ...document.profile, id: "wrong" } }));
  assert.equal((yield* get).status, 503);
  yield* fs.writeFileString(path, "damaged");
  assert.equal((yield* get).status, 503);
`));

test("Dashboard Snapshot page reads explicit v1 and v2 JSON and rejects an invalid document", () => run(`
  const path = join(dataDir, "snapshot.json");
  const read = dashboard(readDocument, path);
  yield* fs.writeFileString(path, fixture);
  assert.equal((yield* read)?.schema_version, 1);

  const v2 = { ...JSON.parse(fixture), schema_version: 2, market_history: null };
  yield* fs.writeFileString(path, JSON.stringify(v2));
  const document = yield* read;
  assert.equal(document?.schema_version, 2);
  assert.equal(document?.market_history, null);

  yield* fs.writeFileString(path, JSON.stringify({ ...v2, schema_version: 3 }));
  assert(Either.isLeft(yield* Effect.either(read)));
`));
