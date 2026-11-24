import { Either, Predicate, Schema } from "effect";
import { spawn } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { piAuthCheckArgv } from "./harness-pi.ts";

export const probeSupervisorPath = fileURLToPath(import.meta.url);
export const probeSeconds = 30;
export const probeTicks = BigInt(probeSeconds * 100);
export const tickMillis = 10;
export const startProbe = "S";
export const cancelFd = 3;
export const readyReceipt = "R";
const stdoutLimit = 64_000;
const parseReady = Schema.decodeUnknownEither(Schema.parseJson(Schema.Struct({ status: Schema.Literal("ready") })));

// Bun's hrtime has a process-local origin. Linux uptime is shared. Use whole
// centiseconds rounded down so the shared expiry cannot extend the budget.
export const probeUptimeTick = (): bigint => {
  if (process.platform !== "linux") throw new Error("probe clock unavailable");
  const match = /^([0-9]+)\.([0-9]{2}) /.exec(readFileSync("/proc/uptime", "utf8"));

  if (!match?.[1] || !match[2]) throw new Error("probe clock unavailable");

  return 100n * BigInt(match[1]) + BigInt(match[2]);
};

export const ownsProbeSession = (stat: string, pid: number): boolean => {
  const identity = String(pid);
  const end = stat.lastIndexOf(")");
  const [, , group, session] = stat.slice(end + 2).split(" ");

  return end >= 0 && stat.startsWith(`${identity} (`) && group === identity && session === identity;
};

const privateProbeControl = (): boolean => {
  try {
    return process.platform === "linux" && process.execArgv.includes("--no-env-file") && fstatSync(0).isSocket() && fstatSync(cancelFd).isSocket()
      && ownsProbeSession(readFileSync("/proc/self/stat", "utf8"), process.pid);
  } catch { return false; }
};

interface ProbeChild {
  readonly stdout: Readable | null;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: () => void): void;
}

export interface SupervisorIO {
  readonly activation: Readable;
  readonly control: Readable;
  readonly output: Writable;
  readonly now: () => bigint;
  readonly start: () => ProbeChild;
  readonly refuseBeforeStart: () => void;
  readonly stopOwnGroup: () => void;
}

// The parent can close the control pipe, but only this live leader may signal
// the group. This timer also covers loss of the parent or its event loop.
export const superviseProbe = (io: SupervisorIO, expires: bigint): void => {
  const remaining = () => {
    try { return expires - io.now(); }
    catch { return 0n; }
  };

  const budget = remaining();

  if (budget <= 0n || budget > probeTicks) return io.refuseBeforeStart();

  let stopped = false;
  let activated = false;
  let received = false;
  let output: Readable | null = null;

  const stop = () => {
    if (stopped) return;

    stopped = true;
    clearTimeout(deadline);

    try { output?.destroy(); }
    finally {
      if (activated) io.stopOwnGroup();
      else io.refuseBeforeStart();
    }
  };

  const deadline = setTimeout(stop, Number(budget) * tickMillis);
  io.output.on("error", stop);
  io.control.on("end", stop);
  io.control.on("error", stop);
  io.control.on("close", stop);
  io.control.on("data", stop);
  io.activation.on("error", stop);
  io.activation.on("close", () => { if (!io.activation.readableEnded) stop(); });
  io.activation.on("data", (chunk: Buffer) => {
    if (received || chunk.length !== 1 || chunk.toString("latin1") !== startProbe) stop();
    else received = true;
  });

  // A stream chunk is not a message. Only EOF closes the finite activation.
  io.activation.on("end", () => setImmediate(() => {
    if (stopped || !received || io.control.destroyed || io.control.readableEnded || remaining() <= 0n) {
      stop();

      return;
    }

    try {
      activated = true;
      const child = io.start();
      const pipe = child.stdout;
      output = pipe;
      child.on("error", stop);

      if (pipe === null) {
        stop();

        return;
      }

      const bytes = new Uint8Array(stdoutLimit);
      let length = 0;
      let eof = false;
      let exited = false;

      const finish = () => {
        if (stopped || !eof || !exited) return;

        try {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));

          if (Either.isRight(parseReady(text)) && remaining() > 0n) {
            io.output.write(readyReceipt, stop);

            return;
          }
        } catch { /* Invalid UTF-8 is not ready. */ }

        stop();
      };

      // Neither raw output nor child error details leave this helper.
      pipe.on("error", stop);
      pipe.on("data", (chunk: Buffer) => {
        if (stopped) return;

        if (chunk.byteLength > bytes.byteLength - length) {
          stop();

          return;
        }

        bytes.set(chunk, length);
        length += chunk.byteLength;
      });
      pipe.on("end", () => { eof = true; finish(); });
      child.on("exit", (code) => {
        if (code !== 0) {
          stop();

          return;
        }

        exited = true;
        finish();
      });
    } catch { stop(); }
  }));
  io.control.resume();
  io.activation.resume();
};

if (import.meta.main) {
  const [executable, provider, model, expiry, ...extra] = process.argv.slice(2);

  if (!privateProbeControl() || !executable || !isAbsolute(executable) || basename(executable) !== "pi"
    || !Predicate.isString(provider) || !Predicate.isString(model) || !expiry || !/^[0-9]{1,16}$/.test(expiry) || extra.length) process.exit(2);

  const control = new Socket({ fd: cancelFd, readable: true, writable: false });
  const { BUN_BE_BUN: _bunMode, ...env } = process.env;

  superviseProbe({
    activation: process.stdin,
    control,
    output: process.stdout,
    now: probeUptimeTick,
    refuseBeforeStart: () => process.exit(2),
    start: () => spawn(executable, piAuthCheckArgv(executable, { provider, model }).slice(1), {
      cwd: process.cwd(), env, detached: false, shell: false, stdio: ["ignore", "pipe", "ignore"],
    }),
    stopOwnGroup: () => {
      try { process.kill(-process.pid, "SIGKILL"); }
      catch { process.exit(2); }
    },
  }, BigInt(expiry));
}
