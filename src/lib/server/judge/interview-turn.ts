import { Context, Effect, Layer, Schema } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InterviewTurnError, interviewEnvironment, interviewPiSettings, interviewStreamLimit,
  parseInterviewResult, prepareInterviewTurn, type InterviewTurnRequest, type InterviewTurnResult,
} from "./interview-protocol.ts";

export { InterviewTurnError, type InterviewTurnRequest, type InterviewTurnResult } from "./interview-protocol.ts";

export class InterviewTurn extends Context.Tag("pulse/InterviewTurn")<InterviewTurn, {
  readonly run: (request: InterviewTurnRequest) => Effect.Effect<InterviewTurnResult, InterviewTurnError>;
}>() {}

const noSuchGroup = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }));
const brokenPipe = Schema.is(Schema.Struct({ code: Schema.Literal("EPIPE") }));

async function captureAndStop(child: ChildProcessWithoutNullStreams, prompt: string, captureDeadline: number,
  deadline: number, signal: AbortSignal): Promise<Buffer> {
  const group = child.pid;
  const parts: Buffer[] = [];
  let total = 0;
  let closed = false;
  let exitCode: number | null | undefined;
  let groupAbsent = group === undefined;
  let stopIssued = false;
  let captureFailure: InterviewTurnError | undefined;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  const { promise: captured, resolve: finishCapture } = Promise.withResolvers<void>();

  const stopGroup = () => {
    if (group === undefined || stopIssued) return;
    stopIssued = true;

    try { process.kill(-group, "SIGKILL"); } catch (error) {
      if (noSuchGroup(error)) groupAbsent = true;
    }
  };

  const collect = (stdout: boolean) => (chunk: Buffer) => {
    if (captureFailure) return;
    total += chunk.length;

    if (total > interviewStreamLimit) finish("stream_too_large");
    else if (stdout) parts.push(chunk);
  };

  const abort = () => finish("transport_failed");

  const finish = (code?: InterviewTurnError["code"]) => {
    if (code) captureFailure ??= new InterviewTurnError({ code });
    finishCapture();
  };

  child.once("exit", (code) => {
    exitCode = code;
    // Descendants can hold the child's pipes open after the direct child exits.
    stopGroup();
  });
  child.once("close", () => { closed = true; finish(); });
  child.on("error", () => finish("transport_failed"));
  child.stdin.on("error", (error) => {
    // The one-shot tool may close stdin before reading its whole prompt.
    if (!brokenPipe(error)) finish("transport_failed");
  });
  child.stdout.on("error", () => finish("transport_failed"));
  child.stderr.on("error", () => finish("transport_failed"));
  child.stdout.on("data", collect(true));
  child.stderr.on("data", collect(false));
  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) abort();
  else if (performance.now() >= captureDeadline) finish("timeout");
  else {
    captureTimer = setTimeout(() => finish("timeout"), captureDeadline - performance.now());

    try { child.stdin.end(prompt, "utf8"); } catch { finish("transport_failed"); }
  }

  await captured;
  clearTimeout(captureTimer);
  signal.removeEventListener("abort", abort);

  if (!captureFailure && performance.now() >= captureDeadline) captureFailure = new InterviewTurnError({ code: "timeout" });

  stopGroup();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();

  // Signal 0 cannot distinguish live members from orphan zombies. Unlike the frozen
  // Linux path, an existing group is not sufficient evidence to remove the cwd.
  // Retry uncertain probes within the same deadline; only ESRCH proves absence.
  // A failed spawn has no owned group, but its pipe close still needs to finish.
  while (performance.now() < deadline) {
    if (!groupAbsent && group !== undefined) {
      try { process.kill(-group, 0); } catch (error) {
        if (noSuchGroup(error)) groupAbsent = true;
      }
    }

    if (groupAbsent && closed && (exitCode !== undefined || group === undefined) &&
        child.stdin.closed && child.stdout.closed && child.stderr.closed && performance.now() < deadline) {
      if (captureFailure) throw captureFailure;

      if (exitCode !== 0) throw new InterviewTurnError({ code: "process_failed" });

      return Buffer.concat(parts);
    }

    const remaining = deadline - performance.now();

    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }

  throw new InterviewTurnError({ code: "cleanup_failed" });
}

async function runInterviewTurn(request: InterviewTurnRequest, signal: AbortSignal): Promise<InterviewTurnResult> {
  if (process.platform === "win32") throw new InterviewTurnError({ code: "transport_failed" });
  const { argv, budgetMs, captureMs } = prepareInterviewTurn(request);
  const start = performance.now();
  let cwd: string | undefined;
  let keep = false;
  let raw: Buffer;

  try {
    cwd = await mkdtemp(join(tmpdir(), "pulse-interview-"));

    if (request.reviewer.harness === "pi") {
      const settings = join(cwd, ".pi");

      await mkdir(settings, { mode: 0o700 });
      await writeFile(join(settings, "settings.json"), interviewPiSettings, { mode: 0o600 });
    }

    if (signal.aborted) throw new InterviewTurnError({ code: "transport_failed" });

    const env = interviewEnvironment(process.env);

    if (performance.now() >= start + captureMs) throw new InterviewTurnError({ code: "timeout" });

    const child = spawn(request.executable, argv.slice(1), {
      cwd, env, detached: true, shell: false, stdio: "pipe",
    });

    keep = true;

    try {
      raw = await captureAndStop(child, request.prompt, start + captureMs, start + budgetMs, signal);
      keep = false;
    } catch (error) {
      if (!(error instanceof InterviewTurnError)) throw new InterviewTurnError({ code: "cleanup_failed" });
      keep = error.code === "cleanup_failed";
      throw error;
    }
  } finally {
    if (cwd && !keep) await rm(cwd, { recursive: true, force: true });
  }

  return parseInterviewResult(raw, request.reviewer);
}

export const InterviewTurnLive = Layer.succeed(InterviewTurn, InterviewTurn.of({
  run: (request) => Effect.async((resume, signal) => {
    const completed = runInterviewTurn(request, signal).then(
      (result) => {
        resume(Effect.succeed(result));

        return undefined;
      },
      (cause: unknown) => {
        const error = cause instanceof InterviewTurnError ? cause : new InterviewTurnError({ code: "transport_failed" });

        resume(Effect.fail(error));

        return error;
      },
    );

    // Effect aborts the callback signal before running this canceler. Wait for the
    // same cleanup, and preserve a cleanup failure in the interrupted fiber cause.
    return Effect.promise(() => completed).pipe(Effect.flatMap((error) =>
      error?.code === "cleanup_failed" ? Effect.die(error) : Effect.void));
  }),
}));
