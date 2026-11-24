import { Terminal } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { expect, test, vi } from "vitest";
import { initLineReader } from "../../src/cli/init-terminal.ts";
import { ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { dispatchSetup, scriptedTerminal } from "./support/init-checkout.ts";

const root = "/invented/checkout";
const invalid = { stdout: "", stderr: "Invalid command or options. See pulse --help.\n", exitStatus: 2 };
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const capture = () => vi.fn(() => Effect.succeed(42));

const layers = Layer.merge(ProfileFilesLive, Layer.succeed(Terminal.Terminal, scriptedTerminal(Effect.die("Unexpected input")).terminal)).pipe(
  Layer.provideMerge(BunFileSystem.layer),
);

const invoke = (args: readonly string[], execute: ReturnType<typeof capture>) => dispatchSetup(root, args, execute).pipe(Effect.provide(layers));

test("init leaf root overrides parent root and parent profile is not reparsed", () => run(Effect.gen(function* () {
  for (const [tokens, selected, profile] of [
    [["init"], root, undefined], [["--root", "init", "init"], "init", undefined],
    [["--root", "discard", "--profile", "init", "init", "--root", "schedule"], "schedule", "init"],
    [["--root=Discard", "init", "--root=LeafRoot"], "LeafRoot", undefined],
    [["--root", "ParentRoot", "init"], "ParentRoot", undefined],
  ] as const) {
    for (const step of ["profile", "reviewer", "geography", "occupations", "exclusions", "interview", "schedule", "alert"]) {
      const execute = capture();
      expect((yield* invoke([...tokens, "--step", step, "--answers", " ./Invented = Answers.TOML ", "--non-interactive", "--advanced", "--dry-run", "--resume"], execute))?.exitStatus).toBe(42);

      const expected = {
        root: selected, answersPath: " ./Invented = Answers.TOML ", step,
        nonInteractive: true, advanced: true, dryRun: true, resume: true,
      };

      expect(execute).toHaveBeenCalledExactlyOnceWith(profile === undefined ? expected : { ...expected, profile });
    }
  }
})));

test("mixed-case syntax is rejected; mixed-case equals values are preserved", () => run(Effect.gen(function* () {
  const execute = capture();

  for (const args of [
    ["init", "--root", "LeafRoot", "--step", "profile", "--DRY-RUN"], ["init", "--STEP", "unsupported"],
    ["init", "--Step=profile"], ["init", "--Root=LeafRoot"], ["init", "--Answers", "Case.TOML"],
    ["init", "--Resume"], ["init", "--Non-interactive"], ["init", "--Advanced"],
    ["--Root", "ParentRoot", "init"], ["--PROFILE=invented", "init"],
    ["--ROOT", "ParentRoot", "init", "--help"], ["--Profile=invented", "init", "--version"],
    ["init", "--HELP"], ["init", "--VERSION"], ["Init"], ["INIT", "--help"],
  ]) expect(yield* invoke(args, execute), JSON.stringify(args)).toEqual(invalid);

  expect(execute).not.toHaveBeenCalled();
  expect((yield* invoke(["--root=ParentRoot", "init", "--root=LeafRoot", "--answers=Case/Answers.TOML", "--dry-run"], execute))?.exitStatus).toBe(42);
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    root: "LeafRoot", answersPath: "Case/Answers.TOML", step: undefined,
    nonInteractive: false, advanced: false, dryRun: true, resume: false,
  });
})));

test("metadata and malformed init never call the wizard", () => run(Effect.gen(function* () {
  const execute = capture();
  const help = yield* invoke(["--root", "init", "--profile", "init", "init", "--help"], execute);
  expect(help?.exitStatus).toBe(0);
  expect(stripVTControlCharacters(help?.stdout ?? "")).toContain("pulse init");
  expect(help?.stdout).toContain("--root");
  expect(help?.stdout).not.toMatch(/--(yes|profile|wizard)\b/u);
  expect((yield* invoke(["init", "--version"], execute))?.exitStatus).toBe(0);

  for (const args of [
    ["--profile", "init", "--root", "--help"], ["init", "--root", "leaf", "--help"], ["init", "--profile", "invented"],
    ["init", "--answers"], ["init", "--answers", "--dry-run"], ["init", "--answers=/invented/with-trailing-space "],
    ["init", "--step", "--resume"], ["init", "--step", ""], ["init", "--step="], ["init", "--step", "unsupported"],
    ["init", "--step=unsupported", "--answers", "unread.toml"], ["init", "--step", "", "--step", "profile"],
    ["init", "--step", "profile", "--step=unsupported"], ["init", "--step= profile"],
    ["init", "--"], ["init", "--yes"], ["init", "--no-dry-run"],
    ...["--dry-run", "--resume", "--non-interactive", "--advanced"].flatMap((flag) => [
      ["init", `${flag}=false`], ["init", flag, "false"], ["init", flag, "true", "--step", "reviewer"],
      ["init", flag, "--answers", "ok", `${flag}=true`],
    ]),
  ]) expect(yield* invoke(args, execute), JSON.stringify(args)).toEqual(invalid);

  expect(execute).not.toHaveBeenCalled();
})));

test("scoped init input is lazy, preserves buffered pipe lines, and removes listeners after EOF", () => run(Effect.gen(function* () {
  const input = new PassThrough();
  const options = vi.fn(() => ({ input, terminal: false }));

  const result = yield* Effect.scoped(Effect.gen(function* () {
    const readLine = yield* initLineReader(options);
    expect(options).not.toHaveBeenCalled();
    input.end("first\r\nsecond\nlast");
    expect(yield* readLine).toBe("first");
    expect(yield* readLine).toBe("second");
    expect(yield* readLine).toBe("last");

    return yield* Effect.flip(readLine);
  }));

  expect(result).toBeInstanceOf(Terminal.QuitException);
  expect(options).toHaveBeenCalledOnce();
  expect(input.listenerCount("data")).toBe(0);
  expect(input.listenerCount("end")).toBe(0);
})));

test("a private prompt is announced only after raw terminal input is active", () => run(Effect.gen(function* () {
  const setRawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
  const output = new PassThrough();

  const ready = Effect.sync(() => {
    expect(setRawMode.mock.calls).toEqual([[true]]);
    input.write("invented-answer\r");
  });

  const answer = yield* Effect.scoped(initLineReader(() => ({ input, output, terminal: true }), ready).pipe(Effect.flatten));
  expect(answer).toBe("invented-answer");
  expect(setRawMode.mock.calls).toEqual([[true], [false]]);
})));

test("Ctrl-C is a readline cancellation, not a process signal", () => run(Effect.gen(function* () {
  const setRawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const signals = process.listenerCount("SIGINT");

  const result = yield* Effect.scoped(Effect.gen(function* () {
    const readLine = yield* initLineReader(() => ({ input, output, terminal: true }));
    input.write("\u0003");

    return yield* Effect.flip(readLine);
  }));

  expect(result).toBeInstanceOf(Terminal.QuitException);
  expect(process.listenerCount("SIGINT")).toBe(signals);
  expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(input.listenerCount("data")).toBe(0);
  expect(input.listenerCount("keypress")).toBe(0);
})));
