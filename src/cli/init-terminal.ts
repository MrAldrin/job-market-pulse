import { Terminal } from "@effect/platform";
import { Effect, Predicate, Scope } from "effect";
import { createInterface, type ReadLineOptions } from "node:readline";
import { PassThrough } from "node:stream";

const quit = () => new Terminal.QuitException();

const attach = (options: ReadLineOptions) => Effect.acquireRelease(
  Effect.sync(() => {
    const { input, terminal } = options;

    if (!terminal) {
      const lines = createInterface({ ...options, crlfDelay: Infinity });

      return { lines, iterator: lines[Symbol.asyncIterator](), releaseInput: () => {} };
    }

    // Readline's key decoder can leave a data listener on its input after
    // close. Give it a private stream, not the process's tty input.
    const bridge = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode: boolean) => {
        if ("setRawMode" in input && Predicate.isFunction(input.setRawMode)) input.setRawMode(mode);
      },
    });

    const lines = createInterface({ ...options, input: bridge, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    input.pipe(bridge);

    return { lines, iterator, releaseInput: () => { input.unpipe(bridge); bridge.destroy(); } };
  }),
  ({ lines, iterator, releaseInput }) => Effect.promise(async () => {
    lines.close();
    releaseInput();
    await iterator.return?.();
  }),
);

type InitInput = Effect.Effect.Success<ReturnType<typeof attach>>;

const readAnswer = ({ lines, iterator }: InitInput) => Effect.async<string, Terminal.QuitException>((resume) => {
  let pending = true;

  const dispose = () => {
    pending = false;
    lines.off("SIGINT", cancel);
  };

  const finish = (answer: Effect.Effect<string, Terminal.QuitException>) => {
    if (!pending) return;
    dispose();
    resume(answer);
  };

  const cancel = () => {
    finish(Effect.fail(quit()));
    lines.close();
  };

  lines.once("SIGINT", cancel);
  void iterator.next().then(
    ({ value, done }) => finish(done ? Effect.fail(quit()) : Effect.succeed(value)),
    () => finish(Effect.fail(quit())),
  );

  return Effect.sync(() => {
    dispose();
    lines.close();
  });
});

// Tty ownership ends at each answer. Keep one iterator for piped stdin so
// later prompts can read answers already buffered in the same chunk.
export const initLineReader = (options: () => ReadLineOptions, ready: Effect.Effect<void> = Effect.void) => Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const settings = yield* Effect.cached(Effect.sync(options));
  const pipeInput = yield* Effect.cached(settings.pipe(Effect.flatMap(attach), Effect.provideService(Scope.Scope, scope)));

  const answer = (input: InitInput) => ready.pipe(Effect.zipRight(readAnswer(input)));

  return settings.pipe(Effect.flatMap((value) => value.terminal
    ? Effect.scoped(attach(value).pipe(Effect.flatMap(answer)))
    : pipeInput.pipe(Effect.flatMap(answer))));
});
