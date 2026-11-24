// In a fresh checkout, install the pinned dependencies and run `bun run build`.
// Then run `bun tests/slow/demo-smoke.ts` from that checkout root.
// Add `--browser` with a local Playwright Chromium cache to check the Salary page.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { parentPipeKey } from "../../src/lib/server/shared/parent-pipe.ts";

if (existsSync("local_only")) throw new Error("Run the demo smoke test in a checkout without local_only");

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
const port = probe.port;

await probe.stop(true);

const origin = `http://127.0.0.1:${port}`;

const pipe = process.platform === "win32" || process.argv.includes("--parent-pipe");
const env = { ...process.env };

if (pipe) env[parentPipeKey] = "1";
else delete env[parentPipeKey];

const child = Bun.spawn([process.execPath, "--no-env-file", "src/cli/pulse.ts", "demo", "--port", String(port)], {
  env, stdout: "inherit", stderr: "inherit", stdin: pipe ? "pipe" : "ignore",
});

let stopped: number | null;

try {
  const deadline = performance.now() + 10_000;
  let page: Response | undefined;

  while (page === undefined && child.exitCode === null && performance.now() < deadline) {
    page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000), redirect: "manual" }).catch(() => undefined);

    if (page === undefined) await Bun.sleep(50);
  }

  if (page?.status !== 303 || page.headers.get("location") !== "/app/") throw new Error("The demo did not redirect to the dashboard");

  const dashboard = await fetch(`${origin}/app/`, { signal: AbortSignal.timeout(2_000), redirect: "error" });

  // Match the job link, not the title in the serialized snapshot.
  const jobLink = /<a\b[^>]*href="#\/jobs\/[^"]+"[^>]*>\s*Datautvikler for oppdiktede tjenester\s*<\/a>/;

  if (!dashboard.ok || !jobLink.test(await dashboard.text())) throw new Error("The dashboard did not render the invented job link");

  if (process.argv.includes("--browser")) {
    const browser = await chromium.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`${origin}/app/#/salary`);
      const table = page.getByRole("table", { name: "Monthly salary statistics and counts" });

      await table.getByRole("cell", { name: "680000", exact: true }).waitFor({ timeout: 5_000 });
      await table.getByRole("cell", { name: "600,000–750,000", exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("heading", { name: "Saved facts by job" }).waitFor({ timeout: 5_000 });
    } finally {
      await browser.close();
    }
  }
} finally {
  if (child.stdin) await child.stdin.end();
  else child.kill("SIGTERM");

  stopped = await Promise.race([child.exited, delay(10_000, null, { ref: false })]);

  if (stopped === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

if (stopped === null) throw new Error("The demo did not shut down in time");

if (pipe && stopped !== 130) throw new Error(`The parent pipe did not stop the demo cleanly: exit ${stopped}`);

if (existsSync("local_only")) throw new Error("The demo created local_only");

console.log("The demo served an invented job without local setup.");
