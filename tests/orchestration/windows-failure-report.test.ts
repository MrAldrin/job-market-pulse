import { Console, Effect, Exit, Predicate } from "effect";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { diagnoseWindowsFailure } from "../../src/lib/server/orchestration/windows-failure-report.ts";

test("Windows failure files preserve stages and exit codes but never serialize private values or errors", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  const reports: string[] = [];
  let privateDirectoryRefused = false;
  const prefix = "Windows failure report: ";

  const secret = "profile=Private Person; token=private-token; C:\\Users\\Private; private comparison text";

  const program = Effect.gen(function* () {
    const output = yield* Effect.console;

    const diagnose = diagnoseWindowsFailure<{ readonly exitCode: number; readonly stderr: string }>("refresh", "runner",
      ({ exitCode }) => exitCode === 0 ? null : { stage: "review", exitCode }, { verify: () => Effect.void });

    const error = new Error(secret);

    const attempts = Effect.gen(function* () {
      const failure = { exitCode: 2, stderr: secret };
      expect(yield* Effect.succeed(failure).pipe(diagnose)).toBe(failure);
      expect(yield* Effect.succeed({ exitCode: 0, stderr: secret }).pipe(diagnose)).toMatchObject({ exitCode: 0 });
      expect(yield* Effect.fail(error).pipe(diagnose, Effect.flip)).toBe(error);
      expect(Exit.isFailure(yield* Effect.die(error).pipe(diagnose, Effect.exit))).toBe(true);
      expect(yield* Effect.fail(error).pipe(diagnoseWindowsFailure("refresh", "runner", () => null, { verify: () => Effect.fail(error) }), Effect.flip)).toBe(error);

      for (const committed of [0, 2, undefined]) {
        const cancelled = diagnoseWindowsFailure<number>("refresh", "runner", (exitCode) => exitCode === 0 ? null : { stage: "review", exitCode }, {
          verify: () => Effect.void, committed: () => committed,
        });

        expect(Exit.isInterrupted(yield* Effect.interrupt.pipe(cancelled, Effect.exit))).toBe(true);
      }
    });

    yield* attempts.pipe(Console.withConsole({ ...output, error: (...args) => Effect.sync(() => {
      const message = args[0];

      if (Predicate.isString(message) && message.startsWith(prefix)) reports.push(message.slice(prefix.length));

      if (Predicate.isString(message) && message.includes("verified private temporary directory")) privateDirectoryRefused = true;
    }) }));
  });

  try {
    await Effect.runPromise(program);
    expect(reports).toHaveLength(5);
    expect(privateDirectoryRefused).toBe(true);

    const outcomes = [
      { stage: "review", error: "Model review did not finish.", exit_code: 2 },
      { stage: "runner", error: "The run stopped unexpectedly.", exit_code: null },
      { stage: "runner", error: "The run stopped unexpectedly.", exit_code: null },
      { stage: "review", error: "Model review did not finish.", exit_code: 2 },
      { stage: "interrupted", error: "The run was interrupted.", exit_code: null },
    ];

    for (const [index, file] of reports.entries()) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/Private|private-token|comparison text|Error:|Users/u);
      expect(JSON.parse(text)).toEqual({
        schema: "pulse.windows-failure", schema_version: 1, pulse_version: expect.stringMatching(/^\d+\.\d+\.\d+/u), bun_version: Bun.version,
        os: { platform: "win32", release: expect.any(String), architecture: process.arch }, operation: "refresh",
        ...outcomes[index],
      });
    }
  } finally {
    Object.defineProperty(process, "platform", original);

    for (const file of reports) await rm(dirname(file), { recursive: true, force: true });
  }
});

test.runIf(process.platform === "win32")("Windows saves a redacted failure report in verified test storage", async () => {
  const prefix = "Windows failure report: ";
  const reports: string[] = [];

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const output = yield* Effect.console;
      const result = { exitCode: 2 };
      const diagnose = diagnoseWindowsFailure<typeof result>("refresh", "runner", ({ exitCode }) => ({ stage: "review", exitCode }));
      expect(yield* Effect.succeed(result).pipe(diagnose, Console.withConsole({ ...output, error: (message) => Effect.sync(() => {
        if (Predicate.isString(message) && message.startsWith(prefix)) reports.push(message.slice(prefix.length));
      }) }))).toBe(result);
    }));

    expect(reports).toHaveLength(1);
    const file = reports[0];

    if (!file) throw new Error("Missing native Windows failure report");

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schema: "pulse.windows-failure", stage: "review", exit_code: 2 });
  } finally {
    for (const file of reports) await rm(dirname(file), { recursive: true, force: true });
  }
});
