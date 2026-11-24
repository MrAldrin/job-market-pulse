import packageInfo from "../../package.json" with { type: "json" };

export const pinnedBun = packageInfo.engines.bun;
export const minimumNode = "22.17.0";
export const nodeFix = `Install Node.js ${minimumNode} or newer and put it on PATH. Check with node --version.`;

export const supportsNode = (version: string | null): boolean =>
  version !== null && Bun.semver.satisfies(version, `>=${minimumNode}`);

export async function readNodeVersion(executable: string | null): Promise<string | null> {
  if (executable === null) return null;

  try {
    const child = Bun.spawn([executable, "--version"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3_000, killSignal: "SIGKILL",
    });

    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    const version = /^v?(\d+\.\d+\.\d+(?:-[\da-z.-]+)?)$/iu.exec(text.trim())?.[1];

    return code === 0 ? version ?? null : null;
  } catch {
    return null;
  }
}
