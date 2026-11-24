import { fileURLToPath } from "node:url";
import { nodeFix, pinnedBun, readNodeVersion, supportsNode } from "./checkout-toolchain.ts";

interface SetupHost {
  readonly interactive: boolean;
  readonly bunVersion: string;
  readonly nodeVersion: () => Promise<string | null>;
  readonly run: (args: readonly string[]) => Promise<number>;
  readonly error: (message: string) => void;
}

const pulse = "src/cli/pulse.ts";

const steps = [
  ["install", "--frozen-lockfile"], ["run", "build"], [pulse, "doctor"], [pulse, "init"],
] as const;

export async function runCheckoutSetup(host: SetupHost): Promise<number> {
  if (!host.interactive) {
    host.error("Run bun run setup in a terminal. The setup wizard needs your answers.");

    return 1;
  }

  if (host.bunVersion !== pinnedBun) {
    host.error(`Use Bun ${pinnedBun} from package.json. Check with bun --version.`);

    return 1;
  }

  if (!supportsNode(await host.nodeVersion())) {
    host.error(nodeFix);

    return 1;
  }

  for (const args of steps) {
    const code = await host.run(args);

    // Doctor exits 1 if setup is incomplete, as expected in a fresh checkout.
    if (code !== 0 && !(args[1] === "doctor" && code === 1)) return code;
  }

  return 0;
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error("Usage: bun run setup");
    process.exitCode = 2;
  } else {
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    process.exitCode = await runCheckoutSetup({
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      bunVersion: Bun.version,
      nodeVersion: () => readNodeVersion(Bun.which("node")),
      run: async (args) => {
        try {
          return await Bun.spawn([process.execPath, "--no-env-file", ...args], {
            cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit",
          }).exited;
        } catch {
          console.error(`Cannot start: bun ${args.join(" ")}`);

          return 2;
        }
      },
      error: console.error,
    });
  }
}
