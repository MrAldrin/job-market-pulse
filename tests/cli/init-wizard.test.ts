import { FileSystem, Terminal } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Clock, Effect, Either, Layer, Scope } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
import { makeCheckoutInitHost } from "../../src/cli/init-checkout-host.ts";
import { runCheckoutInit } from "../../src/cli/init-command.ts";
import { initLineReader } from "../../src/cli/init-terminal.ts";
import { InitMissingAnswer } from "../../src/cli/init-prompts.ts";
import { initFingerprints, prepareInitInputs } from "../../src/cli/init-recovery.ts";
import { freshInitConfig, isInitTomlTable, loadInitState } from "../../src/cli/init-state.ts";
import { runSetupWizard } from "../../src/cli/init-wizard.ts";
import { InterviewCancelled, type InterviewIO } from "../../src/cli/interview-session.ts";
import { InterviewTurn } from "../../src/lib/server/judge/interview-turn.ts";
import { decodeModelSettings } from "../../src/lib/server/judge/reviewers.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { NarrativeResources, narrativeResourcesLayer } from "../../src/lib/server/profile/narrative-service.ts";
import { decodeCatalog } from "../../src/lib/server/profile/occupation-catalog.ts";
import { PostcodeAreaTag } from "../../src/lib/server/profile/postcode-area.ts";
import { decodeFilters, decodeJudge } from "../../src/lib/server/profile/settings.ts";
import { parseToml, writeToml } from "../../src/lib/server/shared/toml.ts";
import supplied from "../fixtures/port-oracle/setup-interview/inputs/answers.json";
import responses from "../fixtures/port-oracle/setup-interview/responses/interview.json";
import record from "../oracle/setup-interview/cli/init.json";
import requests from "../oracle/setup-interview/setup/model-requests.json";
import { dispatchSetup, scriptedTerminal } from "./support/init-checkout.ts";
import { withPendingSource } from "./support/profile-findings.ts";

const oracleFiles = new URL("../oracle/setup-interview/setup/files/", import.meta.url);
const expectedFile = (path: string): string => readFileSync(new URL(path, oracleFiles), "utf8");
const publicConfig = (path: string): string => readFileSync(new URL(`../../config/${path}`, import.meta.url), "utf8");
const catalog = Either.getOrThrow(decodeCatalog(publicConfig("occupation_categories.toml")));
const profileDir = "local_only/profiles/invented";
const checkpoint = "local_only/init-answers.toml";
const resources = narrativeResourcesLayer({ template: "skills/pulse-interview/profile-template.md", questions: "skills/pulse-interview/questions.toml", catalog: "config/occupation_categories.toml", suggestions: "" });
const layers = Layer.merge(resources, ProfileFilesLive).pipe(Layer.provideMerge(BunFileSystem.layer));

type Resources = FileSystem.FileSystem | NarrativeResources | ProfileFiles | Scope.Scope;

const run = <A, E>(effect: Effect.Effect<A, E, Resources>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers)));
const options = { advanced: false, dryRun: false, step: undefined, resume: false, nonInteractive: false };

const unexpected = () => Effect.die("Unexpected setup service call");

const inert = {
  osloDate: "2026-10-19", lookupDate: "2026-10-19", catalog,
  lookup: unexpected, planModels: unexpected, selectGuided: unexpected, readinessLines: unexpected,
};

const promptIO = (ask: InterviewIO["ask"]) => {
  let stdout = "";
  const asked: string[] = [];

  const io: InterviewIO = {
    ask: (prompt) => Effect.sync(() => { stdout += prompt; asked.push(prompt); }).pipe(Effect.zipRight(ask(prompt))),
    say: (text) => Effect.sync(() => { stdout += text + "\n"; }),
  };

  return { io, asked, stdout: () => stdout };
};

const withoutFingerprints = (text: string) => text.replace(/^"fingerprints" = .*\n/mu, "");

test.each([true, false])("synthetic setup offers the desktop launcher only after saving: save=%s", async (saveSettings) => {
  vi.stubEnv("TZ", "UTC");
  onTestFinished(() => { vi.unstubAllEnvs(); });

  const expectedModels = Either.getOrThrow(decodeModelSettings(expectedFile("models.toml")));
  const detect = vi.fn(() => Effect.succeed([{ harness: "pi", executable: "/synthetic/pi", isFile: true }] as const));
  const query = vi.fn(unexpected);

  const lookup = vi.fn((postcode: string) => Effect.succeed({ postcode, poststed: "INVENTED", latitude: 60, longitude: 10 }));
  const turns = requests.values();
  const replies = responses.values();

  const transport = InterviewTurn.of({ run: (request) => Effect.sync(() => {
    const expected = turns.next();
    const reply = replies.next();

    if (expected.done || reply.done) throw new Error("Unexpected extra interview request");
    expect(JSON.parse(request.prompt)).toEqual(expected.value.prompt);
    expect(request.timeoutSeconds).toBe(expected.value.limits.timeout_seconds);
    expect(request.reviewer).toEqual(expectedModels.judge);
    expect(request.executable).toBe("/synthetic/pi");

    return { text: JSON.stringify(reply.value), reportedModel: request.reviewer.model };
  }) });

  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const answersPath = join(root, "standalone.toml");
    yield* fs.writeFileString(answersPath, yield* writeToml({
      ...supplied, save: "yes", interview_history: ["invented model history"], draft: "invented draft",
      model_prose: "invented model prose", interview_replacement: "unaccepted replacement", interview_section: "not an editable section",
    }));

    const launcherPrompt = "Add Job Market Pulse to the app menu? [y/N] ";

    const installLauncher = vi.fn((install: boolean) => Effect.gen(function* () {
      expect(install).toBe(true);
      expect(yield* fs.exists(join(root, profileDir, "profile.toml")).pipe(Effect.orDie)).toBe(true);

      return { stdout: "Wrote launcher\n", stderr: "", exitStatus: 0 };
    }));

    let reads = 0;

    const script = scriptedTerminal(Effect.gen(function* () {
      if (++reads === 2) return "yes";
      expect(yield* fs.readDirectory(join(root, "local_only"))).toEqual(["init-answers.toml"]);
      const saved = yield* fs.readFileString(join(root, checkpoint));
      expect(saved).not.toMatch(/"(?:save|interview_history|draft|model_prose|interview_replacement|interview_section)" =/u);

      return saveSettings ? "yes" : "no";
    }).pipe(Effect.orDie));

    const result = yield* dispatchSetup(root, ["--root", "/unused-parent", "init", "--root", root, "--answers", answersPath], (request) => runCheckoutInit(request, {
      detect, query, desktopLauncher: { installed: Effect.succeed(false), change: installLauncher }, monotonicSeconds: () => 123, executable: (name) => Effect.sync(() => {
        expect(name).toBe("pi");

        return "/synthetic/pi";
      }),
    })).pipe(
      Effect.provideService(Terminal.Terminal, script.terminal),
      Effect.provideService(PostcodeAreaTag, { lookup }),
      Effect.withClock({ ...Clock.make(), currentTimeMillis: Effect.succeed(Date.UTC(2026, 9, 19, 10)) }),
    );

    expect(result, script.stdout()).toEqual({ stdout: "", stderr: "", exitStatus: record.exit_status });
    expect(yield* fs.exists(join(root, "data", "nav.sqlite3"))).toBe(false);

    if (!saveSettings) {
      expect(installLauncher).not.toHaveBeenCalled();
      expect(script.stdout()).not.toContain(launcherPrompt);
      expect(yield* fs.exists(join(root, profileDir))).toBe(false);

      return;
    }

    expect(installLauncher).toHaveBeenCalledExactlyOnceWith(true);
    const frozen = withPendingSource(record.stdout.replace("Nothing is installed.", "Nothing is installed automatically."));
    const save = frozen.indexOf("Save these settings?");

    const launcherGuide = "The menu entry needs Electron, a dashboard build and a saved snapshot for the selected profile.\n"
      + "To try invented jobs first, run bun run build, then bun src/cli/pulse.ts demo from the checkout.\n";

    // Three split settings files replace one preferences file. The quick
    // display labels all of them as profile data; all other bytes must match.
    expect(script.stdout()).toBe(frozen.slice(0, save) + "  new  profile data\n".repeat(2) + frozen.slice(save) + launcherGuide + launcherPrompt + "Wrote launcher\n");
    expect(script.asked).toEqual([frozen.slice(save, frozen.indexOf("ok  profile_dir")), launcherPrompt]);

    for (const name of ["models.toml", "pulse.toml", "profiles/invented/profile.toml", "profiles/invented/profile.md"]) {
      expect(yield* fs.readFileString(join(root, "local_only", name))).toBe(expectedFile(name));
    }

    const legacy = yield* parseToml(expectedFile("profiles/invented/preferences.toml"));

    if (!isInitTomlTable(legacy.jobs) || !isInitTomlTable(legacy.geography)) return yield* Effect.die("Invalid frozen preferences");

    const { preferred_terms, ...filterJobs } = legacy.jobs;
    const { area_postcode: _legacyArea, ...geography } = legacy.geography;
    const filters = yield* decodeFilters(yield* fs.readFileString(join(root, profileDir, "filters.toml")));
    const judge = yield* decodeJudge(yield* fs.readFileString(join(root, profileDir, "judge.toml")));

    expect(filters).toEqual({ geography, jobs: filterJobs });
    expect(judge).toEqual({ jobs: { preferred_terms } });
    expect(yield* fs.readFileString(join(root, profileDir, "screen.toml"))).toBe(publicConfig("title_exclusions.neutral.toml"));
    expect(yield* fs.exists(join(root, profileDir, "preferences.toml"))).toBe(false);

    const raw = yield* fs.readFileString(join(root, checkpoint));
    expect(withoutFingerprints(raw)).toBe(withoutFingerprints(expectedFile("init-answers.toml")));
    const { metadata } = yield* parseToml(raw);

    if (!isInitTomlTable(metadata)) return yield* Effect.die("Invalid recovery metadata");

    expect(metadata.fingerprints).toEqual(yield* initFingerprints(yield* loadInitState(root)));
  }).pipe(Effect.provideService(InterviewTurn, transport)));

  expect(lookup).toHaveBeenCalledExactlyOnceWith("0123");
  expect(detect).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
  expect(turns.next().done && replies.next().done).toBe(true);
});

test("checkout dry-run skips interview effects and leaves the installation empty", async () => {
  const script = scriptedTerminal(unexpected());
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    const answersPath = join(root, "answers.toml");
    yield* fs.writeFileString(answersPath, yield* writeToml(supplied));

    const result = yield* dispatchSetup(root, ["init", "--dry-run", "--answers", answersPath], (request) => runCheckoutInit(request, {
      detect: () => Effect.succeed([{ harness: "pi", executable: "/synthetic/pi", isFile: true }]), executable: unexpected, query: unexpected,
      desktopLauncher: { installed: Effect.dieMessage("Unexpected launcher check"), change: unexpected },
    })).pipe(
      Effect.provideService(Terminal.Terminal, script.terminal),
      Effect.provideService(PostcodeAreaTag, { lookup: (postcode) => Effect.succeed({ postcode, poststed: "INVENTED", latitude: 60, longitude: 10 }) }),
      Effect.provideService(InterviewTurn, { run: unexpected }),
    );

    expect(result?.exitStatus, script.stdout()).toBe(0);
    expect(script.stdout()).toContain("AI interview was skipped in this dry run.");
    expect(script.stdout()).toContain("Dry run. No files were written.");
    expect(yield* fs.readDirectory(root)).toEqual(["answers.toml"]);
  }));
});

test.each(["EOF", "Ctrl-C"] as const)("readline %s reaches checkout recovery; resume needs fresh save consent", (stop) => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const checkout = yield* fs.makeTempDirectoryScoped();

  const execute = (request: Parameters<typeof runCheckoutInit>[0]) => runCheckoutInit(request, {
    detect: unexpected, query: unexpected, executable: unexpected,
    desktopLauncher: { installed: Effect.dieMessage("Unexpected launcher check"), change: unexpected },
  }).pipe(
    Effect.provideService(PostcodeAreaTag, { lookup: unexpected }), Effect.provideService(InterviewTurn, { run: unexpected }),
  );

  const invoke = (tokens: readonly string[], terminal: boolean, ...flags: string[]) => Effect.scoped(Effect.gen(function* () {
    const answers = tokens.values();

    const setRawMode = vi.fn((raw: boolean) => {
      if (raw) queueMicrotask(() => input.write(answers.next().value ?? "\u0003"));
    });

    const input = Object.assign(new PassThrough(), { isTTY: terminal, setRawMode });

    if (!terminal) input.end(tokens.join(""));
    const script = scriptedTerminal(unexpected());
    const readLine = yield* initLineReader(() => ({ input, terminal }));

    const parent = flags.includes("--resume") ? ["--profile", "invented"] : [];

    const result = yield* dispatchSetup(checkout, [...parent, "init", "--root", root, "--step", "profile", ...flags], execute).pipe(
      Effect.provideService(Terminal.Terminal, { ...script.terminal, readLine }),
    );

    if (terminal) {
      expect(setRawMode.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
      expect(input.listenerCount("data")).toBe(0);
    }

    return { status: result?.exitStatus, text: script.stdout() };
  }));

  const stopped = yield* invoke(["invented\n", "2\n"], stop === "Ctrl-C");
  expect(stopped.status).toBe(130);
  expect(stopped.text).toContain("Save these settings?");
  expect(stopped.text).toContain("Use the same installation root and select profile invented. Run the init command with --resume --step profile.");
  expect(stopped.text).not.toContain(root);
  expect(yield* fs.readDirectory(checkout)).toEqual([]);
  expect(yield* fs.exists(join(root, profileDir))).toBe(false);
  const saved = yield* fs.readFileString(join(root, checkpoint));
  expect(saved).toContain('"search_mode" = "active"');
  expect(saved).not.toContain('"save" =');

  const declined = yield* invoke(["\n", "no\n"], false, "--resume");
  expect(declined.status, declined.text).toBe(0);
  expect(declined.text).toContain("No planned files were written.");
  expect(yield* fs.exists(join(root, profileDir))).toBe(false);

  const applied = yield* invoke(["\n", "yes\n"], false, "--resume");
  expect(applied.status, applied.text).toBe(0);
  expect(applied.text).toContain("Search mode (current: active; press Enter to keep it)");
  expect(applied.text).toContain("Save these settings?");
  expect(yield* fs.readFileString(join(root, profileDir, "profile.toml"))).toContain('mode = "active"');
})));

test("native metadata-unavailable host requires new named model and effort without running a binary", () => run(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const inventedExecutable = join(root, "pi");
  const answersPath = join(root, "standalone.toml");
  yield* fs.writeFileString(inventedExecutable, "invented executable metadata only");
  const which = vi.fn((name) => name === "pi" ? inventedExecutable : null);
  const host = makeCheckoutInitHost(which);
  expect(host.query).toBeNull();

  const invoke = (answers: Readonly<Record<string, string>>) => Effect.gen(function* () {
    yield* fs.writeFileString(answersPath, yield* writeToml({ ai_program: "pi", ...answers }));
    const script = scriptedTerminal(unexpected());

    const result = yield* dispatchSetup(root, ["init", "--step", "reviewer", "--answers", answersPath, "--non-interactive"], (request) => runCheckoutInit(request, host)).pipe(
      Effect.provideService(Terminal.Terminal, script.terminal), Effect.provideService(PostcodeAreaTag, { lookup: unexpected }),
      Effect.provideService(InterviewTurn, { run: unexpected }),
    );

    return { status: result?.exitStatus, text: script.stdout() };
  });

  const missingModel = yield* invoke({});
  expect(missingModel.status).toBe(1);
  expect(missingModel.text).toContain("Model metadata is unavailable");
  expect(missingModel.text).toContain("Missing answers: ai_model");
  const missingEffort = yield* invoke({ ai_model: "invented/model" });
  expect(missingEffort.status).toBe(1);
  expect(missingEffort.text).toContain("Effort metadata is unavailable");
  expect(missingEffort.text).toContain("Missing answers: ai_effort");
  const named = yield* invoke({ ai_model: "invented/model", ai_effort: "low", save: "yes" });
  expect(named.status).toBe(1);
  expect(named.text).not.toContain("Missing answers:");
  expect(named.text).toContain("Confirmation needs a terminal.");
  expect(named.text).not.toMatch(/returned no models|model list failed/iu);
  expect(yield* fs.exists(join(root, "local_only", "models.toml"))).toBe(false);
  expect(which.mock.calls.map(([name]) => name)).toEqual(["claude", "pi", "claude", "pi", "claude", "pi"]);
})));

test("named answers aggregate missing keys across ordinary steps and interview", async () => {
  const script = promptIO(unexpected);

  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    const result = yield* runSetupWizard({ ...options, root, profile: "invented", nonInteractive: true, dryRun: true }, script.io, {
      ...inert, planModels: () => Effect.fail(new InitMissingAnswer({ key: "screen_harness" })),
    });

    expect(result, script.stdout()).toBe(1);
    // Dry run intentionally skips the interview before it can require a key.
    expect(script.stdout()).toContain("Missing answers: search_mode, screen_harness, place_query, occupation_choices\n");
    expect(yield* fs.readDirectory(root)).toEqual([]);

    const ordinary = promptIO(unexpected);

    const resultWithInterview = yield* runSetupWizard({ ...options, root, profile: "invented", nonInteractive: true }, ordinary.io, {
      ...inert, planModels: () => Effect.fail(new InitMissingAnswer({ key: "screen_harness" })),
    });

    expect(resultWithInterview, ordinary.stdout()).toBe(1);
    expect(ordinary.stdout()).toContain("Missing answers: search_mode, screen_harness, place_query, occupation_choices, interview_method\n");
    expect(yield* fs.exists(join(root, profileDir))).toBe(false);
  }));
});

test("first-run missing profile ID preserves the aggregate report without creating any files", async () => {
  const script = promptIO(unexpected);

  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    const result = yield* runSetupWizard({ ...options, root, nonInteractive: true }, script.io, {
      ...inert, planModels: () => Effect.fail(new InitMissingAnswer({ key: "screen_harness" })),
    });

    expect(result, script.stdout()).toBe(1);
    expect(script.stdout()).toContain("Missing answers: profile_id, screen_harness, place_query, occupation_choices\n");
    expect(script.stdout()).not.toContain("Run the profile step first.");
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }));
});

const cancelled = () => Effect.fail(new InterviewCancelled({ message: "Input ended." }));

const scriptThenCancel = (values: readonly string[]) => {
  const input = values.values();

  return promptIO(() => Effect.suspend(() => {
    const next = input.next();

    return next.done ? cancelled() : Effect.succeed(next.value);
  }));
};

test("first-run cancellation at search mode keeps a resumable profile ID", async () => {
  const script = scriptThenCancel(["invented"]);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const request = { ...options, root, step: "profile" };
    const result = yield* runSetupWizard(request, script.io, inert);
    expect(result, script.stdout()).toBe(130);
    expect(script.stdout()).toContain("Use the same installation root and select profile invented. Run the init command with --resume --step profile.");
    expect(yield* fs.exists(join(root, profileDir))).toBe(false);
    const resumed = yield* prepareInitInputs({ ...request, resume: true });
    expect(resumed.state.profile?.id).toBe("invented");
    expect(resumed.answers).toEqual({ profile_id: "invented" });
  }));
});

test("standalone interview cancellation at the menu does not create a recovery parent", async () => {
  const script = scriptThenCancel([]);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const result = yield* runSetupWizard({ ...options, root, profile: "invented", step: "interview" }, script.io, inert);

    expect(result, script.stdout()).toBe(130);
    expect(script.stdout()).toContain("no recovery file was created");
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }));
});

test("repeated cancellation retains the new cadence and weekday through resume", async () => {
  const script = scriptThenCancel(["2", "monday"]);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const dir = join(root, profileDir);
    const original = (yield* freshInitConfig("invented")) + '\n[schedule]\nschedule = "daily 09:00"\n';
    const request = { ...options, root, step: "schedule" };
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(join(dir, "profile.toml"), original);
    const result = yield* runSetupWizard(request, script.io, inert);
    expect(result, script.stdout()).toBe(130);
    expect(yield* fs.readFileString(join(dir, "profile.toml"))).toBe(original);
    const resumed = yield* prepareInitInputs({ ...request, resume: true });
    expect(resumed.answers).toMatchObject({ schedule_choice: "weekly", schedule_weekday: "monday", schedule_time: "09:00" });
    expect(resumed.answers).not.toHaveProperty("schedule_normalized");

    const cancelledAgain = scriptThenCancel(["", ""]);
    const again = yield* runSetupWizard({ ...request, resume: true }, cancelledAgain.io, inert);
    expect(again, cancelledAgain.stdout()).toBe(130);
    expect(cancelledAgain.asked).toContain("Weekday (current: monday; press Enter to keep it): ");
    expect(yield* fs.readFileString(join(dir, "profile.toml"))).toBe(original);
    const partial = yield* prepareInitInputs({ ...request, resume: true });
    expect(partial.answers).toMatchObject({ schedule_choice: "weekly", schedule_weekday: "monday" });
    expect(partial.answers).not.toHaveProperty("schedule_normalized");

    const next = scriptThenCancel(["", "", "16:00", "yes", "yes"]);
    const finished = yield* runSetupWizard({ ...request, resume: true }, next.io, { ...inert, readinessLines: () => Effect.succeed([]) });
    expect(finished, next.stdout()).toBe(0);
    expect(next.stdout()).toContain("Pending schedule choice: weekly.");
    expect(next.asked).toContain("Weekday (current: monday; press Enter to keep it): ");
    const configured = yield* parseToml(yield* fs.readFileString(join(dir, "profile.toml")));
    expect(configured.schedule).toEqual({ schedule: "weekly mon 16:00" });
  }));
});

test("rejected section text never reaches recovery or changes the narrative", async () => {
  const original = "# Profile\n## Who I am\nI work on invented data.\n";
  const script = scriptThenCancel(["2", "1", "lorem ipsum"]);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const dir = join(root, profileDir);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(join(dir, "profile.toml"), yield* freshInitConfig("invented"));
    yield* fs.writeFileString(join(dir, "profile.md"), original);
    const result = yield* runSetupWizard({ ...options, root, step: "interview" }, script.io, inert);

    expect(result, script.stdout()).toBe(130);
    expect(script.stdout()).toContain("The replacement did not pass the content and privacy checks.");
    expect(yield* fs.readFileString(join(dir, "profile.md"))).toBe(original);
    const saved = yield* parseToml(yield* fs.readFileString(join(root, checkpoint)));
    expect(saved.answers).toMatchObject({ interview_section: "1" });
    expect(saved.answers).not.toHaveProperty("interview_replacement");
  }));
});

test("an explicitly named section reaches recovery only after matching the current menu", async () => {
  const original = "# Profile\n## Who I am\nInvented work.\n";
  const script = promptIO(unexpected);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const dir = join(root, profileDir);
    const answersPath = join(root, "answers.toml");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(join(dir, "profile.toml"), yield* freshInitConfig("invented"));
    yield* fs.writeFileString(join(dir, "profile.md"), original);
    yield* fs.writeFileString(answersPath, 'interview_existing = "2"\ninterview_section = "1"\ninterview_replacement = "lorem ipsum"\n');

    const result = yield* runSetupWizard({ ...options, root, step: "interview", answersPath, nonInteractive: true }, script.io, {
      ...inert, readinessLines: () => Effect.succeed([]),
    });

    expect(result, script.stdout()).toBe(0);
    const saved = yield* parseToml(yield* fs.readFileString(join(root, checkpoint)));
    expect(saved.answers).toMatchObject({ interview_section: "1", interview: "kept" });
    expect(saved.answers).not.toHaveProperty("interview_replacement");
    expect(yield* fs.readFileString(join(dir, "profile.md"))).toBe(original);
  }));
});

test.each([false, true])("interview cancellation preserves accepted facts only when the recovery parent exists: %s", async (existing) => {
  const input = ["2", "I build invented tools."].values();

  const script = promptIO(() => Effect.suspend(() => {
    const next = input.next();

    return next.done ? Effect.fail(new InterviewCancelled({ message: "Input ended." })) : Effect.succeed(next.value);
  }));

  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    if (existing) yield* fs.makeDirectory(join(root, "local_only"), { mode: 0o700 });

    const result = yield* runSetupWizard({ ...options, root, profile: "invented", step: "interview" }, script.io, inert);
    expect(result, script.stdout()).toBe(130);
    expect(yield* fs.exists(join(root, profileDir))).toBe(false);

    if (!existing) {
      expect(yield* fs.readDirectory(root)).toEqual([]);
      expect(script.stdout()).toContain("Stopped. Interview answers were kept in memory only; no recovery file was created.");

      return;
    }

    const saved = yield* parseToml(yield* fs.readFileString(join(root, checkpoint)));
    expect(saved.answers).toEqual({
      profile_id: "invented", interview_method: "2", interview_current_role: "I build invented tools.", interview: "incomplete",
    });
    expect(saved.metadata).toMatchObject({ status: "incomplete", step: "interview", profile_id: "invented" });
    expect(script.stdout()).toContain("Use the same installation root and select profile invented. Run the init command with --resume --step interview.");
  }));
});

test("cancellation before a fresh profile ID does not apply settings", async () => {
  const script = promptIO(() => Effect.fail(new InterviewCancelled({ message: "Input ended." })));
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const result = yield* runSetupWizard({ ...options, root, step: "profile" }, script.io, inert);

    expect(result).toBe(130);
    expect(script.stdout()).toContain("Stopped. No profile ID was saved.");
    expect(yield* fs.exists(join(root, profileDir))).toBe(false);
  }));
});
