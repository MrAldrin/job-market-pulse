import { Cause, Console, Effect, Exit } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import packageInfo from "../../../../package.json" with { type: "json" };
import { verifyWindowsPrivateDirectory } from "../shared/windows-private-files.ts";

const messages = {
  preflight: "Refresh prerequisites were not met.",
  "review-preflight": "Review prerequisites were not met. Check the model harness and private Judge state.",
  pipeline: "Pulse did not confirm a completed pipeline run.",
  "sync-source": "Source sync did not finish.",
  "resolve-locations": "Location resolution did not finish.",
  review: "Model review did not finish.",
  snapshot: "Snapshot capture did not finish.",
  "snapshot-export": "Pulse could not prepare the snapshot for upload.",
  upload: "Pulse did not confirm a snapshot upload.",
  schedule: "Pulse could not start the scheduled run or record its result.",
  lock: "Pulse could not use the installation lock.",
  runner: "The run stopped unexpectedly.",
  interrupted: "The run was interrupted.",
  "schedule-install": "Task installation did not finish.",
  "schedule-status": "Pulse could not check the registered task.",
  "schedule-remove": "Task removal did not finish.",
  "schedule-run-now": "Pulse could not request an immediate task run.",
} as const;

export type WindowsFailureStage = keyof typeof messages;

export type WindowsOperation = "refresh" | "run-scheduled" | "dashboard-run" | "re-review" | "schedule";

export interface WindowsFailure {
  readonly stage: WindowsFailureStage;
  readonly exitCode: number | null;
}

type VerifyDirectory = (path: string) => Effect.Effect<void, unknown>;

const save = (operation: WindowsOperation, failure: WindowsFailure, verify: VerifyDirectory) => Effect.gen(function* () {
  const temp = tmpdir();
  yield* verify(temp);

  return yield* writeReport(operation, failure, temp);
}).pipe(Effect.matchEffect({
  onFailure: () => Console.error("Could not save the Windows failure report in a verified private temporary directory."),
  onSuccess: (file) => Console.error(`Windows failure report: ${file}`),
}));

const writeReport = (operation: WindowsOperation, failure: WindowsFailure, temp: string) => Effect.tryPromise(async () => {
  // No exception, stack, stdout, arguments, environment, path, or profile
  // values enter the document. The console shows the path separately.
  const stage = Object.hasOwn(messages, failure.stage) ? failure.stage : "runner";

  const report = {
    schema: "pulse.windows-failure", schema_version: 1,
    pulse_version: packageInfo.version, bun_version: Bun.version,
    os: { platform: "win32", release: release(), architecture: process.arch },
    operation, stage, error: messages[stage],
    exit_code: failure.exitCode !== null && Number.isInteger(failure.exitCode) && failure.exitCode >= 1 && failure.exitCode <= 255
      ? failure.exitCode : null,
  };

  const directory = await mkdtemp(join(temp, "pulse-failure-"));
  const file = join(directory, "report.json");
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  return file;
});

interface DiagnosticOptions<A> {
  readonly verify?: VerifyDirectory;
  readonly committed?: () => A | undefined;
}

export const diagnoseWindowsFailure = <A>(operation: WindowsOperation, fallback: WindowsFailureStage, failed: (value: A) => WindowsFailure | null, options: DiagnosticOptions<A> = {}) =>
  <E, R>(run: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.suspend(() => process.platform !== "win32" ? run : run.pipe(
    Effect.onExit((exit) => {
      // Cancelling best-effort delivery must not replace the committed result.
      const committed = options.committed?.();

      const failure = committed !== undefined ? failed(committed) : Exit.isSuccess(exit) ? failed(exit.value)
        : { stage: Cause.isInterruptedOnly(exit.cause) ? "interrupted" as const : fallback, exitCode: null };

      return failure === null ? Effect.void : save(operation, failure, options.verify ?? verifyWindowsPrivateDirectory).pipe(Effect.catchAllDefect(() => Effect.void));
    }),
  ));
