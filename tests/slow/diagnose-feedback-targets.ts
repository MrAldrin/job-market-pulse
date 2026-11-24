// Run separately against the reserved production build. No browser or build here.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FEEDBACK_EVENTS_PATH } from "../../src/lib/contracts/feedback-events.ts";
import { b8SnapshotBytes } from "./b8-fixture.ts";
import { dotTarget, feedbackAlias, feedbackOrigin, feedbackPath, feedbackToken, literalFeedbackStatus } from "./feedback-fixture.ts";

const address = new URL(feedbackOrigin);

async function observe(target: string, host: string, bearer: boolean, expected?: number): Promise<boolean> {
  try {
    const headers = bearer ? { Authorization: `Bearer ${feedbackToken}` } : undefined;
    const status = await literalFeedbackStatus(target, host, "GET", headers);

    console.log(JSON.stringify({ method: "GET", target, host, bearer, status, expected }));

    return expected === undefined || status === expected;
  } catch {
    console.log(JSON.stringify({ method: "GET", target, host, bearer, status: null, expected }));

    return false;
  }
}

async function matrix(): Promise<void> {
  const results = [];

  // Initialize only the invented phone store through its canonical browser read.
  results.push(await observe(feedbackPath, address.host, false, 200));

  for (const host of [address.host, feedbackAlias]) {
    for (const [path, bearer] of [["/api/v1/starred-jobs", true], [FEEDBACK_EVENTS_PATH, true], [feedbackPath, false]] as const) {
      results.push(await observe(path, host, bearer, 200));
      results.push(await observe(path + "?profile_id=other", host, bearer, bearer ? 400 : 404));

      if (bearer) results.push(await observe(path, host, false, 401));
      // Report observations, not parity assertions. Neither status proves which stage normalized the target.
      results.push(await observe(path + "?", host, bearer));
      results.push(await observe(dotTarget(path), host, bearer));
    }
  }

  if (results.includes(false)) throw new Error("Loopback request or control failed; do not interpret the matrix");
}

const root = await mkdtemp(join(tmpdir(), "pulse-feedback-diagnostic-"));

try {
  const dataDir = join(root, "feedback");
  const snapshot = join(root, "snapshot-v2.json");

  await mkdir(dataDir, { mode: 0o700 });
  await Bun.write(snapshot, b8SnapshotBytes(new Uint8Array(await Bun.file("contracts/fixtures/snapshot.example.json").arrayBuffer())));

  const adapter = Bun.spawn([process.execPath, resolve("build/index.js")], {
    timeout: 45_000, killSignal: "SIGKILL", stdout: "pipe", stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NODE_ENV: "production",
      HOST: address.hostname, PORT: address.port, ORIGIN: feedbackOrigin,
      PULSE_DASHBOARD_MODE: "local", PULSE_DATA_DIR: dataDir, PULSE_DASHBOARD_SNAPSHOT: snapshot,
      DIGEST_VIEW_ALLOWED_HOSTS: `${address.host},${feedbackAlias}`,
      DIGEST_VIEW_FEEDBACK_PROFILE: "demo", DIGEST_VIEW_STARRED_PROFILE: "demo",
      DIGEST_VIEW_STARRED_INSTANCE: "invented-loopback", DIGEST_VIEW_STARRED_TOKEN: feedbackToken,
    },
  });

  try {
    // Wait for this child to bind; do not send even the invented token to an existing listener.
    let startup = "";
    let listening = false;

    for await (const chunk of adapter.stdout.pipeThrough(new TextDecoderStream())) {
      startup += chunk;

      if (startup.split("\n").includes(`Listening on ${address.href}`)) {
        listening = true;
        await matrix();
        break;
      }

      if (startup.length > 4_096) break;
    }

    if (!listening) throw new Error("Built adapter did not bind the diagnostic loopback address");
  } finally {
    adapter.kill();
    await adapter.exited;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
