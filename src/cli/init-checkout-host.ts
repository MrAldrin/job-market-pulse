import { FetchHttpClient, FileSystem, Terminal } from "@effect/platform";
import { Effect, Layer } from "effect";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { InterviewTurnLive } from "../lib/server/judge/interview-turn.ts";
import { detectHarnesses, harnessExecutables } from "../lib/server/judge/reviewer-detect.ts";
import { LookupHttpLive } from "../lib/server/profile/lookup-http.ts";
import { narrativeResourcesLayer } from "../lib/server/profile/narrative-service.ts";
import { PostcodeAreaLive } from "../lib/server/profile/postcode-area.ts";
import { bundledResource } from "../lib/server/shared/installation-paths.ts";
import { prepareDesktop } from "./desktop.ts";
import { nativeDesktopLauncher } from "./desktop-launcher.ts";
import { runCheckoutInit, type CheckoutInitHost } from "./init-command.ts";
import { initLineReader } from "./init-terminal.ts";
import type { SetupWizardRequest } from "./init-wizard.ts";

const resource = (path: string) => bundledResource(fileURLToPath(new URL("../../", import.meta.url)), path);

const resources = narrativeResourcesLayer({
  catalog: resource("config/occupation_categories.toml"),
  template: resource("skills/pulse-interview/profile-template.md"),
  questions: resource("skills/pulse-interview/questions.toml"),
});

const postcodeArea = PostcodeAreaLive.pipe(Layer.provide(LookupHttpLive), Layer.provide(FetchHttpClient.layer));

export const makeCheckoutInitHost = (which: (name: typeof harnessExecutables[keyof typeof harnessExecutables]) => string | null): CheckoutInitHost<FileSystem.FileSystem> => ({
  executable: (name) => Effect.sync(() => which(name)),
  detect: () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = detectHarnesses((name) => name === "claude" || name === "pi" ? which(name) : null);

    return yield* Effect.forEach(installed, ({ harness, executable }) => executable === null ? Effect.succeed([]) : fs.stat(executable).pipe(
      Effect.map((stat) => stat.type === "File" ? [{ harness, executable, isFile: true }] : []),
      Effect.orElseSucceed(() => []),
    ), { concurrency: 1 }).pipe(Effect.map((rows) => rows.flat()));
  }),
  query: null,
});

export const checkoutInit = (request: SetupWizardRequest) => Effect.scoped(Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal;

  if (request.step === "alert" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return yield* terminal.display("Use a terminal for pulse init --step alert.\n").pipe(Effect.orDie, Effect.as(1));
  }

  const readLine = yield* initLineReader(() => ({
    input: process.stdin, output: process.stdout.isTTY === true ? process.stdout : undefined,
    terminal: process.stdin.isTTY === true,
  }));

  // Display the prompt only after readline takes raw TTY ownership. Before
  // then the OS can echo an answer even when readline's output is discarded.
  const readSecret = (prompt: string) => Effect.scoped(initLineReader(() => ({
    input: process.stdin, terminal: true,
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
  }), terminal.display(prompt).pipe(Effect.orDie)).pipe(Effect.flatten));

  const host = makeCheckoutInitHost((name) => Bun.which(name));
  const launcher = process.stdin.isTTY && process.stdout.isTTY ? nativeDesktopLauncher(process.platform, (name) => Bun.which(name)) : undefined;

  return yield* runCheckoutInit(request, launcher === undefined ? host : { ...host, desktopLauncher: { ...launcher, prepare: prepareDesktop } }, readSecret).pipe(
    Effect.provideService(Terminal.Terminal, { ...terminal, readLine }),
    Effect.provide(resources), Effect.provide(InterviewTurnLive), Effect.provide(postcodeArea),
  );
}));
