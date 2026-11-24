import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));

  if (address === null || !(address instanceof Object)) throw new Error("No loopback port");

  return address.port;
}

function signalIfPresent(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

for (const stop of ["SIGTERM", "parent pipe EOF", "SIGKILL"] as const) {
  test(`real dashboard child stops on ${stop}`, async () => {
    test.skip(process.platform !== "linux", "Uses Linux procfs to check the server PID.");
    const port = await freePort();
    const home = await mkdtemp(join(tmpdir(), "pulse-dashboard-stop-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };

    if (stop === "parent pipe EOF") env.PULSE_PARENT_PIPE = "1";

    const cli = spawn("bun", ["--no-env-file", "src/cli/pulse.ts", "dashboard", "--snapshot",
      resolve("contracts/fixtures/snapshot.example.json"), "--port", String(port)], {
      env,
      stdio: "pipe",
    });

    cli.stdin.on("error", () => { /* The CLI can exit before cleanup. */ });
    cli.stderr.resume();
    let output = "";
    cli.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    const closed = new Promise<void>((done) => cli.once("close", () => done()));
    const origin = `http://127.0.0.1:${port}`;
    let serverPid: number | undefined;

    try {
      await expect.poll(() => output, { timeout: 8_000 }).toContain(`Listening on ${origin}/`);
      const children = await readFile(`/proc/${cli.pid}/task/${cli.pid}/children`, "utf8");
      expect(children.trim()).toMatch(/^\d+$/u);
      serverPid = Number(children.trim());
      expect((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1_000) })).status).toBe(200);

      if (stop === "parent pipe EOF") cli.stdin.end();
      else cli.kill(stop);

      await expect.poll(() => cli.exitCode ?? cli.signalCode, { timeout: 5_000 }).toBe(stop === "SIGKILL" ? "SIGKILL" : 130);
      // An orphan can remain a zombie until its new parent reaps it. Either
      // state must release the inherited stdout and stderr and stop listening.
      await expect.poll(async () => {
        const stat = await readFile(`/proc/${serverPid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });

        return stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
      }, { timeout: 5_000 }).toBe(true);
      serverPid = undefined;
      await closed;
      await expect(fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      cli.kill("SIGKILL");

      if (serverPid !== undefined) signalIfPresent(serverPid, "SIGKILL");

      cli.stdout.destroy();
      cli.stderr.destroy();
      await closed;
      await rm(home, { recursive: true });
    }
  });
}
