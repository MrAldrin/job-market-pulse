import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Deferred, Effect, Either, Fiber, Layer, Option, Predicate } from "effect";
import type { JsonInput } from "../../src/lib/server/shared/json-input.ts";
import { PythonFloat } from "../../src/lib/server/shared/python-json.ts";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { FixedOsloClock } from "../../src/lib/server/clock.ts";
import { AppLive } from "../../src/lib/server/runtime.ts";
import { initialProfileConfig } from "../../src/lib/server/profile/core.ts";
import { Profile } from "../../src/lib/server/profile/service.ts";
import { initializeSourceStorage } from "../../src/lib/server/source/schema.ts";
import { acquireStore } from "../../src/lib/server/source/store.ts";
import { openJudgeDatabase } from "../../src/lib/server/judge/database.ts";
import { ReviewerHarness } from "../../src/lib/server/judge/harness.ts";
import { modelCallLog } from "../../src/lib/server/judge/model-log.ts";
import { latestOpenRun, readRun } from "../../src/lib/server/judge/runs.ts";
import { runAttempts } from "../../src/lib/server/judge/views.ts";
import { runReviewSession } from "../../src/lib/server/judge/workflow-driver.ts";
import { WorkflowError } from "../../src/lib/server/judge/workflow-errors.ts";
import { serveReviewSession, type ReviewProtocolIO } from "../../src/lib/server/judge/workflow-protocol.ts";
import { ReviewProfileLock } from "../../src/lib/server/judge/workflow-service.ts";
import { parseProtocolLine } from "../../src/lib/server/judge/protocol.ts";
import type { ReviewEvent } from "../../src/lib/server/judge/workflow-receipt.ts";
import { ReviewProfileLockLive } from "../../src/lib/server/orchestration/workflow-locks.ts";

const checked = "2026-10-19T12:00:00+00:00";
const listing = "00000000-0000-0000-0000-000000000001";
const reviewer = { id: "judge", harness: "pi", provider: "synthetic", model: "offline", effort: "medium", batch_size: 1, max_budget_usd: null, timeout_seconds: 1800 } as const;
const labels = { harness_label: reviewer.harness, provider_label: reviewer.provider, model_label: reviewer.model, reasoning_level: reviewer.effort };

type TestFrame = Readonly<Record<string, JsonInput>>;

const bytes = (value: TestFrame) => new TextEncoder().encode(JSON.stringify(value) + "\n");
let held = false;
let acquired = 0;
const lock = Layer.succeed(ReviewProfileLock, { acquire: () => Effect.acquireRelease(Effect.sync(() => { assert.equal(held, false); held = true; acquired++; }), () => Effect.sync(() => { held = false; })) });

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pulse-b10-io-" });
  const directory = join(root, "local_only", "profiles", "invented");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(join(directory, "outbox"));
  yield* fs.makeDirectory(join(root, "data"));
  yield* fs.writeFileString(join(directory, "profile.toml"), (yield* initialProfileConfig("invented")).replace("data/REPLACE_WITH_SHARED_FEED.sqlite3", "data/source.sqlite3"));
  yield* fs.writeFileString(join(directory, "filters.toml"), '[geography]\norigin_latitude = 60.0\norigin_longitude = 10.0\norigin_source = "invented"\nradius_km = 40.0\npreferred_municipalities = ["Invented town"]\n[jobs]\nallowed_occupation_categories = ["IT"]\n');
  yield* fs.writeFileString(join(directory, "judge.toml"), '[jobs]\npreferred_terms = ["developer"]\n');
  yield* fs.writeFileString(join(directory, "screen.toml"), "academic = []\n");
  yield* fs.writeFileString(join(directory, "profile.md"), "Synthetic software profile.\n");
  const source = yield* acquireStore(join(root, "data", "source.sqlite3"), "create");
  yield* initializeSourceStorage(source);
  yield* source`INSERT INTO state VALUES ('checked',${checked}),('caught_up','1')`;
  yield* source`INSERT INTO ads VALUES (${listing},${checked},${checked},${checked},'Synthetic developer','Synthetic employer','["Invented town"]','[]',0,'2099-01-01T00:00:00+00:00','NAV')`;
  yield* source`INSERT INTO versions VALUES (${listing},${checked})`;
  yield* source`INSERT INTO ad_locations VALUES (${listing},'[[60.0,10.0]]',0,'{}')`;
  yield* source`INSERT INTO ad_occupations VALUES (${listing},'occupationCategories','IT','Software','','')`;
  const selected = yield* (yield* Profile).load(root, "invented");
  const optionsFor = (name: string) => ({ context: { root, profile: { ...selected.bundle, paths: { ...selected.bundle.paths, review_db: join(directory, `${name}.sqlite3`) } } }, reviewer, host: "synthetic-host", readOnlySource: true });
  const selectionFor = (name: string) => ({ profile_id: "invented", directory, path: optionsFor(name).context.profile.paths.review_db, readonly: false, require_existing: true });

  // No lock Layer means no database acquisition. Invalid options also stop first.
  const noIO: ReviewProtocolIO = { readLine: Effect.die("Unexpected protocol input"), writeLine: () => Effect.void };
  assert(Option.isNone(yield* Effect.serviceOption(ReviewProfileLock)));
  const missingLock = yield* Effect.exit(serveReviewSession(optionsFor("missing-lock"), noIO).pipe(Effect.provideServiceEffect(ReviewProfileLock, Effect.die("No lock binding"))));
  assert.equal(missingLock._tag, "Failure");
  assert.equal(yield* fs.exists(selectionFor("missing-lock").path), false);
  assert.equal(yield* serveReviewSession({ ...optionsFor("invalid"), maxCalls: 0 }, noIO).pipe(Effect.provide(lock)), 2);
  assert.equal(yield* serveReviewSession({ ...optionsFor("invalid-host"), host: "bad host" }, noIO).pipe(Effect.provide(lock)), 2);
  assert.equal(yield* serveReviewSession({ ...optionsFor("invalid-selection"), reviewAll: true, listingIds: [listing] }, noIO).pipe(Effect.provide(lock)), 2);
  assert.equal(acquired, 0);

  for (const name of ["invalid", "invalid-host", "invalid-selection"]) assert.equal(yield* fs.exists(selectionFor(name).path), false);

  for (const name of ["success", "mismatch", "cancel", "unknown", "failed", "interrupted", "skip"]) {
    const frames: Uint8Array[] = [];
    const events: ReviewEvent[] = [];
    let blockedInput = false;
    const submitted = yield* Deferred.make<void>();

    const io: ReviewProtocolIO = {
      readLine: Effect.suspend(() => blockedInput ? Effect.never : Effect.succeed(frames.shift() ?? null)),
      writeLine: (line) => Effect.sync(() => {
        const event = JSON.parse(new TextDecoder().decode(line));

        if (event.type !== "blocked") assert.equal(held, true);
        events.push(event);

        if (event.type === "request") {
          if (name === "cancel") { frames.push(bytes({ type: "cancel_before_submit", attempt_id: event.attempt_id }));

 return; }

          frames.push(bytes({ type: "submit", attempt_id: event.attempt_id, ...labels }));
          const prompt = JSON.parse(event.user_prompt);
          const raw = JSON.stringify({ ...prompt.response_template, assessments: prompt.candidates.map((candidate: { id: string; version: string }) => ({ id: candidate.id, version: candidate.version, outcome: "screened_out", reason: "Synthetic title is outside scope." })) });
          frames.push(bytes({ type: name === "unknown" || name === "failed" || name === "skip" ? (name === "failed" ? "failed" : "unknown") : "result",
            attempt_id: name === "mismatch" ? "wrong-attempt" : event.attempt_id, ...(name === "unknown" || name === "failed" || name === "skip" ? { error_code: name === "failed" ? "invalid_model_response" : "provider_temporary", diagnostics: { branch: "provider_unknown", excerpt: "PRIVATE_REPLY_TEXT" } } : { raw_result: raw }), input_tokens: 7, output_tokens: 3, wall_time_seconds: 0.5 }));
        }

        if (event.type === "submitted" && name === "interrupted") blockedInput = true;

        if (event.type === "retry_confirmation") frames.push(bytes({ type: "skip_retry", attempt_id: event.attempt_id }));
      }).pipe(Effect.tap(() => blockedInput ? Deferred.succeed(submitted, undefined) : Effect.void)),
    };

    const effect = serveReviewSession(optionsFor(name), io).pipe(Effect.provide(lock));

    if (name === "interrupted") {
      const fiber = yield* Effect.fork(effect);
      yield* Deferred.await(submitted);
      yield* Fiber.interrupt(fiber);
    } else assert.equal(yield* effect, name === "mismatch" ? 2 : 0);
    assert.equal(held, false);
    yield* Effect.scoped(Effect.gen(function* () {
      const store = yield* openJudgeDatabase(selectionFor(name));
      const run = yield* latestOpenRun(store);
      const runId = run?.run_id ?? String(events.find((event) => event["run_id"] !== undefined)?.["run_id"]);
      const attempts = yield* runAttempts(store, runId);
      const log = yield* modelCallLog(store, runId);
      assert.equal(attempts.length, 1);

      if (name === "success") {
        assert.equal(attempts[0]?.status, "completed");
        assert.equal(events.at(-1)?.["status"], "completed");
      }

      if (name === "cancel") { assert.equal(attempts[0]?.status, "pending"); assert.equal(log.length, 0); }
      else if (name === "mismatch" || name === "interrupted") { assert.equal(attempts[0]?.status, "unknown"); assert.equal(log[0]?.output_tokens, null); }
      else { assert.equal(log[0]?.output_tokens, 3); assert.deepEqual(log[0]?.wall_time_seconds, new PythonFloat(0.5)); }

      if (name === "skip" || name === "unknown" || name === "failed") {
        assert.equal(events.at(-1)?.["not_reviewed_count"], 1);
        assert.equal(events.at(-1)?.["skip_failed_count"], 1);
        assert.equal(JSON.stringify(events).includes("PRIVATE_REPLY_TEXT"), false);
      }
    }));
  }

  // Execute only an invented program, through the real managed Command adapter.
  const windows = process.platform === "win32";
  const executable = join(root, windows ? "offline-pi.exe" : "offline-pi");
  const script = windows ? join(root, "offline-pi.js") : executable;
  const code = `const p=JSON.parse(await Bun.stdin.text());\nconst r={...p.response_template,assessments:p.candidates.map(c=>({id:c.id,version:c.version,outcome:"screened_out",reason:"Synthetic role is outside scope."}))};\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",model:"offline",stopReason:"stop",content:[{type:"text",text:JSON.stringify(r)}],usage:{input:7,output:3}}}));\n`;
  yield* fs.writeFileString(script, windows ? code : `#!${process.execPath}\n${code}`, { mode: 0o700 });

  if (windows) {
    // Windows cannot execute a shebang script. Use the local pinned runtime,
    // not a shell wrapper or a downloaded cross-compile target.
    const build = yield* Effect.promise(() => Bun.build({ entrypoints: [script],
      compile: { executablePath: process.execPath, outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    }));

    assert(build.success);
  }

  const result = yield* runReviewSession(optionsFor("driver"), { executableFor: () => Effect.succeed(executable), onEvent: () => Effect.sync(() => assert.equal(held, true)), retry: () => Effect.die("Unexpected driver retry") }).pipe(Effect.provide(lock));

  assert.equal(result["status"], "completed");
  assert.equal(held, false);
  yield* Effect.scoped(Effect.gen(function* () {
    const store = yield* openJudgeDatabase(selectionFor("driver"));
    const runId = result["run_id"]; assert(Predicate.isString(runId));
    const log = yield* modelCallLog(store, runId);
    assert.equal(log[0]?.input_tokens, 7);
    assert.equal(log[0]?.output_tokens, 3);
  }));

  const nativeIO = {
    executableFor: () => Effect.succeed(executable),
    onEvent: () => Effect.void,
    retry: () => Effect.dieMessage("Unexpected retry in the native driver"),
  };

  const budgetOptions = { ...optionsFor("driver-budget"), reviewAll: true, maxCalls: 1 };
  const budget = yield* runReviewSession(budgetOptions, nativeIO).pipe(Effect.provide(ReviewProfileLockLive));
  const budgetRunId = budget["run_id"];

  assert(Predicate.isString(budgetRunId));
  assert.equal(budget["type"], "budget_exhausted");
  yield* Effect.scoped(Effect.gen(function* () {
    const store = yield* openJudgeDatabase(selectionFor("driver-budget"));

    assert.equal((yield* readRun(store, budgetRunId)).status, "superseded");
    assert.equal((yield* runAttempts(store, budgetRunId))[0]?.status, "completed");
  }));
  const afterBudget = yield* runReviewSession(budgetOptions, { ...nativeIO, executableFor: () => Effect.dieMessage("Already screened") }).pipe(Effect.provide(ReviewProfileLockLive));
  assert.equal(afterBudget["status"], "no_pending_candidates");

  for (const [errorCode, safeCode] of [["provider_temporary", "provider_temporary"], ["harness_call_error", "review_outcome_unknown"]] as const) {
    const events: ReviewEvent[] = [];
    let calls = 0;

    const observed = yield* runReviewSession({ ...optionsFor(errorCode), reviewAll: true }, {
      ...nativeIO, onEvent: (event) => Effect.sync(() => { events.push(event); }),
    }).pipe(Effect.provideService(ReviewerHarness, { call: () => Effect.sync(() => {
      calls++;

      return { status: "unknown" as const, text: null, error_code: errorCode, input_tokens: 7,
        output_tokens: 3, wall_time_seconds: 0.5, diagnostics: { branch: "provider_unknown" } };
    }) }), Effect.provide(ReviewProfileLockLive), Effect.either);

    assert(Either.isLeft(observed) && observed.left instanceof WorkflowError);
    assert.equal(observed.left.code, safeCode);
    assert.equal(calls, 1);
    assert.equal(events.at(-1)?.["status"], "unknown");
    yield* Effect.scoped(Effect.gen(function* () {
      const store = yield* openJudgeDatabase(selectionFor(errorCode));
      const open = yield* latestOpenRun(store);
      assert(open);
      const attempts = yield* runAttempts(store, open.run_id);
      const receipts = yield* modelCallLog(store, open.run_id);

      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.status, "unknown");
      assert.equal(attempts[0]?.error_code, safeCode);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.output_tokens, 3);
      assert.deepEqual(receipts[0]?.wall_time_seconds, new PythonFloat(0.5));
    }));
    let confirmations = 0;

    const recovered = yield* runReviewSession({ ...optionsFor(errorCode), reviewAll: errorCode === "provider_temporary" }, {
      ...nativeIO, retry: () => Effect.sync(() => {
        confirmations++;

        return "retry" as const;
      }),
    }).pipe(Effect.provide(ReviewProfileLockLive));

    assert.equal(recovered["status"], "completed");
    assert.equal(confirmations, errorCode === "provider_temporary" ? 0 : 1);
  }

  // A manual rebatch may prepare the same input under a new batch key. Canceling
  // that request must not replace the previous submitted outcome for the input.
  const peerB = "00000000-0000-0000-0000-000000000002";
  const peerC = "00000000-0000-0000-0000-000000000003";

  const addPeer = (id: string) => Effect.gen(function* () {
    yield* source`INSERT INTO ads VALUES (${id},${checked},${checked},${checked},'Synthetic peer developer','Synthetic employer','["Invented town"]','[]',0,'2099-01-01T00:00:00+00:00','NAV')`;
    yield* source`INSERT INTO versions VALUES (${id},${checked})`;
    yield* source`INSERT INTO ad_locations VALUES (${id},'[[60.0,10.0]]',0,'{}')`;
    yield* source`INSERT INTO ad_occupations VALUES (${id},'occupationCategories','IT','Software','','')`;
  });

  yield* addPeer(peerB);
  const name = "cancelled-manual-rebatch";
  const options = { ...optionsFor(name), maxCandidates: 2 };
  const calls: string[][] = [];

  const runAutomatic = () => runReviewSession({ ...options, reviewAll: true }, nativeIO).pipe(
    Effect.provideService(ReviewerHarness, { call: (request) => Effect.sync(() => {
      const prompt = JSON.parse(request.user_prompt);
      calls.push(prompt.candidates.map((candidate: { id: string }) => candidate.id).sort());

      return { status: "unknown" as const, text: null, error_code: "harness_call_error", input_tokens: 7,
        output_tokens: 3, wall_time_seconds: 0.5, diagnostics: { branch: "provider_unknown" } };
    }) }), Effect.provide(ReviewProfileLockLive), Effect.either,
  );

  const first = yield* runAutomatic();

  assert(Either.isLeft(first) && first.left instanceof WorkflowError);
  assert.equal(first.left.code, "review_outcome_unknown");
  assert.deepEqual(calls, [[listing, peerB]]);

  yield* source`DELETE FROM ads WHERE uuid=${peerB}`;
  yield* addPeer(peerC);
  const frames: Uint8Array[] = [];
  const manualRequests: string[][] = [];

  const manual: ReviewProtocolIO = {
    readLine: Effect.sync(() => frames.shift() ?? null),
    writeLine: (line) => Effect.sync(() => {
      const event = JSON.parse(new TextDecoder().decode(line));

      if (event.type !== "request") return;
      const prompt = JSON.parse(event.user_prompt);
      manualRequests.push(prompt.candidates.map((candidate: { id: string }) => candidate.id).sort());
      frames.push(bytes({ type: "cancel_before_submit", attempt_id: event.attempt_id }));
    }),
  };

  assert.equal(yield* serveReviewSession(options, manual).pipe(Effect.provide(ReviewProfileLockLive)), 0);
  assert.deepEqual(manualRequests, [[listing, peerC]]);
  yield* Effect.scoped(Effect.gen(function* () {
    const store = yield* openJudgeDatabase(selectionFor(name));
    const open = yield* latestOpenRun(store);
    assert(open);
    const attempts = yield* runAttempts(store, open.run_id);

    assert.deepEqual(attempts.map((attempt) => [attempt.status, attempt.provenance.call_count]), [["pending", 0]]);
    assert.equal((yield* modelCallLog(store, open.run_id)).length, 0);
  }));

  const afterCancel = yield* runAutomatic();

  assert(Either.isLeft(afterCancel) && afterCancel.left instanceof WorkflowError);
  assert.equal(afterCancel.left.code, "review_outcome_unknown");
  assert.deepEqual(calls, [[listing, peerB]]);

  assert(Either.isLeft(yield* Effect.either(parseProtocolLine(bytes({ type: "submit", attempt_id: "a", extra: true })))));
})).pipe(Effect.provide(AppLive), Effect.provide(FixedOsloClock), Effect.provide(BunContext.layer)));
