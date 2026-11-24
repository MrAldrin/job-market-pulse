// Run inside the already-built image with --network=none. This foreground
// harness owns one adapter child at a time and never publishes a port.
const modes = ["railway", "local"] as const;

for (const mode of modes) {
  const child = Bun.spawn([process.execPath, "build/index.js"], { stdout: "inherit", stderr: "inherit", env: {
    PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8770",
    PULSE_DASHBOARD_MODE: mode, PULSE_DATA_DIR: "/data",
    DIGEST_VIEW_USER: "invented", DIGEST_VIEW_PASSWORD: "synthetic-password-0123456789",
    DIGEST_VIEW_SESSION_SECRET: "synthetic-session-secret-0123456789",
  } });

  try {
    let healthy = false;

    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch("http://127.0.0.1:8770/healthz").catch(() => null);

      if (response?.ok) { healthy = true; break; }

      await Bun.sleep(50);
    }

    if (!healthy) throw new Error("Container health route did not answer");

    const page = await fetch("http://127.0.0.1:8770/app/", {
      redirect: "manual", headers: { "x-real-ip": "127.0.0.1", "x-forwarded-for": "::1" },
    });

    const snapshot = await fetch("http://127.0.0.1:8770/app/snapshot.json", { redirect: "manual" });

    if (mode === "railway" && (page.status !== 303 || snapshot.status !== 303)) throw new Error("Hosted loopback escaped login");

    if (mode === "local" && (page.status !== 200 || snapshot.status !== 404)) throw new Error("Default-origin native loopback was not recognized");
    console.log(`Container: ${mode} /healthz and page/data gate passed; default origin, forged address headers`);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}

for (const header of ["x-real-ip", " "]) {
  const child = Bun.spawn([process.execPath, "build/index.js"], { stdout: "pipe", stderr: "pipe", env: {
    PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8770",
    PULSE_DASHBOARD_MODE: "local", PULSE_DATA_DIR: "/data", ADDRESS_HEADER: header,
  } });

  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  const code = await child.exited;
  clearTimeout(deadline);
  const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();

  if (code === 0 || !output.includes("Dashboard configuration is invalid") || output.includes("Listening on")) throw new Error("ADDRESS_HEADER did not fail before serving");
}

console.log("Container: both nonempty ADDRESS_HEADER cases refused before serving; UID", process.getuid?.());

if (process.getuid?.() !== 10001) throw new Error("Container is not UID 10001");
