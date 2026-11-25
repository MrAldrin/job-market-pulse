import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Scope } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BudgetedInterviewIO, InterviewBudgetExhausted, InterviewCancelled, InterviewTurnFailure, guidedInterview, runInterviewSession, type GuidedInterview, type InterviewIO } from "../../src/cli/interview-session.ts";
import { InterviewMissingAnswer, guardInterviewConfirmation, runInterviewStep } from "../../src/cli/interview-step.ts";
import { InterviewTurn } from "../../src/lib/server/judge/interview-turn.ts";
import type { Reviewer } from "../../src/lib/server/judge/reviewers.ts";
import { ProfileFiles, ProfileFilesLive } from "../../src/lib/server/profile/files.ts";
import { NarrativeResources, narrativeResourcesLayer } from "../../src/lib/server/profile/narrative-service.ts";
import type { Answers } from "../../src/lib/server/profile/narrative.ts";
import { sha256 } from "../../src/lib/server/shared/python-json.ts";
import recordedAnswers from "../fixtures/port-oracle/setup-interview/inputs/answers.json";
import recordedResponses from "../fixtures/port-oracle/setup-interview/responses/interview.json";
import recordedInit from "../oracle/setup-interview/cli/init.json";
import recordedIndex from "../oracle/setup-interview/setup/file-index.json";
import recordedRequests from "../oracle/setup-interview/setup/model-requests.json";

const reviewer: Reviewer = { id: "judge", provider: "synthetic", model: "fixed", harness: "pi", effort: "medium", batch_size: 5, max_budget_usd: null, timeout_seconds: 1800 };
const fixtures = narrativeResourcesLayer({ template: "skills/pulse-interview/profile-template.md", questions: "skills/pulse-interview/questions.toml", catalog: "", suggestions: "" });
const layers = Layer.merge(fixtures, ProfileFilesLive).pipe(Layer.provideMerge(BunFileSystem.layer));

type Services = NarrativeResources | ProfileFiles | FileSystem.FileSystem | Scope.Scope;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers)));
const knownKeys = new Set(Object.keys(recordedAnswers));
const path = "local_only/profiles/invented/profile.md";

const human = (answers: readonly string[]) => {
  const said: string[] = [];
  const asked: string[] = [];
  const values = answers.values();

  const io: InterviewIO = {
    ask: (prompt) => Effect.suspend(() => {
      asked.push(prompt);
      const next = values.next();

      return next.done ? Effect.fail(new InterviewCancelled({ message: "Input ended." })) : Effect.succeed(next.value);
    }),
    say: (text) => Effect.sync(() => { said.push(text); }),
  };

  return { said, asked, io };
};

const select = (callTurn: GuidedInterview<never>["callTurn"]): GuidedInterview<never> => ({ executable: "synthetic-pi", reviewer, callTurn });
const script = (root: string, io: InterviewIO) => ({ root, profileId: "invented", io, answers: recordedAnswers, explicitKeys: knownKeys, recoveredKeys: new Set<string>(), interactive: true, dryRun: false, monotonicSeconds: () => 0 });

const withResources = Effect.gen(function* () {
  const resources = yield* NarrativeResources;
  const questions = yield* resources.questions();
  const template = yield* resources.template;

  return { questions, template };
});

const reply = (questionId: string, followUp: number | null = null) => JSON.stringify({ question_id: questionId, reflection: "Synthetic reflection, not a fact.", follow_up: followUp });

test("replays the frozen interview prompts, stdout slice, draft bytes and file-index entry", async () => {
  const { said, asked, io } = human([]);
  const requests = recordedRequests.values();
  const responses = recordedResponses.values();

  const selection = guidedInterview(reviewer, "synthetic-pi");

  const transport = InterviewTurn.of({ run: (request) => Effect.sync(() => {
    const expected = requests.next();
    const result = responses.next();

    if (expected.done || result.done) throw new Error("Unexpected extra interview call");
    expect(request.executable).toBe("synthetic-pi");
    expect(JSON.parse(request.prompt)).toEqual(expected.value.prompt);
    expect(request.timeoutSeconds).toBe(expected.value.limits.timeout_seconds);
    expect({ reviewer_id: request.reviewer.id, harness: request.reviewer.harness, model: request.reviewer.model, provider: request.reviewer.provider,
      effort: request.reviewer.effort, batch_size: request.reviewer.batch_size }).toEqual(expected.value.reviewer);

    return { text: JSON.stringify(result.value), reportedModel: request.reviewer.model };
  }) });

  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const step = yield* runInterviewStep({ ...script(root, io), selectGuided: Effect.succeed(selection) });
    expect(step.status).toBe("planned");

    if (step.status !== "planned") return;
    const indexed = recordedIndex[path];
    const draft = readFileSync(new URL(`../oracle/setup-interview/${indexed.artifact}`, import.meta.url));
    expect(Buffer.from(step.plan.content)).toEqual(draft);
    expect({ path: step.plan.path, mode: `0o${step.plan.mode.toString(8)}`, digest: sha256(step.plan.content), size: Buffer.byteLength(step.plan.content) })
      .toEqual({ path: join(path), mode: indexed.mode, digest: indexed.sha256, size: indexed.size_bytes });
    expect(step.plan).toMatchObject({ overwrite: false, expectedDigest: "missing" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.provideService(InterviewTurn, transport)));
  const stdout = recordedInit.stdout;
  expect(said.join("\n") + "\n").toBe(stdout.slice(stdout.indexOf("1. Guided interview inside setup"), stdout.indexOf("6/7  Schedule")));
  expect(requests.next().done && responses.next().done).toBe(true);
  expect(asked).toEqual([]);
});

test("only trusted follow-up wording and human facts are retained; differing identity is advised once", async () => {
  const { io, asked, said } = human(["I prefer fewer maintenance outages."]);
  const checkpoints: Answers[] = [];

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;
    const ids = resources.questions.filter((q) => !["minimum_salary", "work_location"].includes(q.id)).map((q) => q.id).values();

    const guided = select(({ prompt }) => Effect.sync(() => {
      const id = ids.next().value;

      if (!id) throw new Error("Unexpected extra interview call");
      expect(JSON.parse(prompt)).toMatchObject({ current_question_id: id, untrusted_context: { existing_text: "Untrusted legacy text" } });

      return { text: reply(id, id === "current_role" ? 1 : null), reportedModel: "unknown-provider-model" };
    }));

    return yield* runInterviewSession({ ...resources, answers: { ...recordedAnswers, save: "yes" }, providedKeys: new Set([...knownKeys, "save"]),
      existingText: "Untrusted legacy text", guided, mode: "guided", io: new BudgetedInterviewIO(io), interactive: true,
      checkpoint: (facts) => Effect.sync(() => { checkpoints.push(facts); }), monotonicSeconds: () => 0 });
  }));

  expect(asked).toEqual(["Which parts do you want less of?: "]);
  expect(result).toMatchObject({ status: "ready", invocations: 26, humanAttempts: 1 });
  expect(result.draft).toContain("Which parts do you want less of? I prefer fewer maintenance outages.");
  expect(result.draft).not.toContain("Synthetic reflection");
  expect(result.draft).not.toContain("Untrusted legacy");
  expect(said.filter((text) => text.startsWith("NOTICE:"))).toHaveLength(1);
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({ interview_current_role_followup_index: 1, interview_current_role_followup_answer: "I prefer fewer maintenance outages." });
  expect(JSON.stringify(checkpoints)).not.toMatch(/unknown-provider-model|Synthetic reflection|Untrusted legacy|"save"/);
});

test.each(["true", "0.0", "0e0", "2", "0,\"follow_up\":null", "0,\"extra\":true"])("invalid model follow-up %s never asks a model-supplied question or retries automatically", async (index) => {
  const { asked, said, io } = human(["3"]);

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;
    const guided = select(() => Effect.succeed({ text: `{"question_id":"current_role","reflection":"do not display this","follow_up":${index}}` }));

    return yield* runInterviewSession({ ...resources, answers: recordedAnswers, providedKeys: knownKeys, io: new BudgetedInterviewIO(io), interactive: true, mode: "guided", guided });
  }));

  expect(result).toMatchObject({ status: "later", invocations: 1, draft: null });
  expect(asked).toEqual(["Choose a number: "]);
  expect(said.join("\n")).not.toContain("do not display this");
});

test("rejects a late reply and excludes human time from the cumulative invocation budget", async () => {
  let now = 0;
  const clock = () => now;
  const deadlines: number[] = [];
  const prompts = human([...Array.from({ length: 10 }, () => "1"), "2"]);
  const io: InterviewIO = { ...prompts.io, ask: (question) => Effect.sync(() => { now += 300; }).pipe(Effect.zipRight(prompts.io.ask(question))) };

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;

    const guided = select(({ timeoutSeconds }) => Effect.suspend(() => {
      deadlines.push(timeoutSeconds);
      now += 59;

      return timeoutSeconds === 60 ? Effect.fail(new InterviewTurnFailure()) : Effect.succeed({ text: reply("current_role") });
    }));

    return yield* runInterviewSession({ ...resources, answers: recordedAnswers, providedKeys: knownKeys, io: new BudgetedInterviewIO(io), interactive: true, mode: "guided", guided, monotonicSeconds: clock });
  }));

  expect(deadlines).toEqual([...Array.from({ length: 10 }, () => 60), 10]);
  expect(result).toMatchObject({ status: "later", invocations: 11, waitSeconds: 649 });
  expect(prompts.said.join("\n")).not.toContain("Synthetic reflection");
});

test("stops at 32 model invocations including explicit retries and failures", async () => {
  const { io } = human([...Array.from({ length: 31 }, () => "retry"), "later"]);

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;

    return yield* runInterviewSession({ ...resources, answers: recordedAnswers, providedKeys: knownKeys, io: new BudgetedInterviewIO(io),
      interactive: true, mode: "guided", guided: select(() => Effect.fail(new InterviewTurnFailure())), monotonicSeconds: () => 0 });
  }));

  expect(result).toMatchObject({ status: "later", invocations: 32, humanAttempts: 32 });
});

test("oversized UTF-8 input counts towards the shared 56-attempt budget without truncation", async () => {
  const { io, asked, said } = human(Array.from({ length: 56 }, () => "å".repeat(2049)));
  const budgeted = new BudgetedInterviewIO(io);
  expect(await Effect.runPromise(Effect.flip(budgeted.ask("Choose a method: ")))).toBeInstanceOf(InterviewBudgetExhausted);
  expect(budgeted.remaining).toBe(0);
  expect(asked).toHaveLength(56);
  expect(new Set(said)).toEqual(new Set(["Enter at most 4 KiB of text."]));
});

test("a noninteractive guided selection uses the short form without program selection; a dry run skips even the root read", async () => {
  const { io, said } = human([]);
  const selectGuided = Effect.dieMessage("Unexpected program selection");
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    expect(yield* runInterviewStep({ ...script("not-a-root", io), dryRun: true, selectGuided })).toEqual({ status: "skipped" });
    expect(yield* runInterviewStep({ ...script(root, io), interactive: false, selectGuided })).toMatchObject({ status: "planned" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }));
  expect(said[0]).toBe("AI interview was skipped in this dry run.");
  expect(said.join("\n")).not.toContain("Guided sends");
});

test("omitting the interview method in noninteractive setup reports a recoverable key without asking or selecting", async () => {
  const { io, asked } = human([]);

  const missing = await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    return yield* runInterviewStep({ ...script(root, io), answers: {}, explicitKeys: new Set(), interactive: false,
      selectGuided: Effect.dieMessage("Unexpected program selection"),
    }).pipe(Effect.catchTag("InterviewMissingAnswer", Effect.succeed));
  }));

  expect(missing).toEqual(new InterviewMissingAnswer({ key: "interview_method" }));
  expect(asked).toEqual([]);
});

test("choosing later with only a recovered follow-up index does not mark the interview incomplete", async () => {
  const { io, asked } = human(["later"]);

  const status = await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    return yield* runInterviewStep({ ...script(root, io),
      answers: { interview_method: "guided", interview_current_role_followup_index: 0 },
      explicitKeys: new Set(["interview_method"]), recoveredKeys: new Set(["interview_current_role_followup_index"]),
      selectGuided: Effect.succeed(null),
    });
  }));

  expect(status).toEqual({ status: "later" });
  expect(asked).toEqual(["Choose a number: "]);
});

test("default keep preserves undecodable original bytes and an oversized original is kept without asking", async () => {
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = join(root, "custom-narrative.md");
    const original = Uint8Array.of(255, 0, 13, 10);
    const { io, asked } = human([""]);
    yield* fs.writeFile(target, original);
    const options = { ...script(root, io), narrativePath: "custom-narrative.md" };
    expect(yield* runInterviewStep(options)).toEqual({ status: "kept" });
    expect(Buffer.from(yield* fs.readFile(target))).toEqual(Buffer.from(original));
    const oversize = new Uint8Array(128 * 1024 + 1).fill(97);
    yield* fs.writeFile(target, oversize);
    expect(yield* runInterviewStep(options)).toEqual({ status: "kept" });
    expect(Buffer.from(yield* fs.readFile(target))).toEqual(Buffer.from(oversize));
    expect(asked).toEqual(["Existing profile text (current: 1; press Enter to keep it): "]);
  }));
});

test("section adjustment plans exact CRLF bytes without touching adjacent text or the file", async () => {
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = join(root, "custom-narrative.md");
    const original = "# Profile\r\n## Who I am\r\nOriginal biography.\r\n## Examples\r\nAn original example.\r\n";
    yield* fs.writeFileString(target, original);
    const { io } = human(["2", "1", "I work with useful public data."]);
    const recorded: [string, string][] = [];

    const result = yield* runInterviewStep({ ...script(root, io), narrativePath: "custom-narrative.md",
      recordMenuAnswer: (key, value) => Effect.sync(() => { recorded.push([key, value]); }),
    });

    expect(recorded).toEqual([["interview_existing", "2"], ["interview_section", "1"], ["interview_replacement", "I work with useful public data."]]);
    expect(result).toMatchObject({ status: "planned", plan: { content: original.replace("Original biography.", "I work with useful public data."), overwrite: true, expectedDigest: sha256(original) } });
    expect(yield* fs.readFileString(target)).toBe(original);
  }));
});

test("refusal leaves the file alone; edits during draft display or terminal confirmation invalidate the baseline", async () => {
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = join(root, "custom.md");
    const original = "Previous private profile bytes.";
    const edited = "New independent edit.";
    const answers = { ...recordedAnswers, keep_narrative: "no", interview_method: "2", confirm: "yes" };
    const { io } = human([]);
    yield* fs.writeFileString(target, original);
    const options = { ...script(root, io), answers, explicitKeys: new Set(Object.keys(answers)), narrativePath: "custom.md" };
    const outcome = yield* runInterviewStep(options);

    if (outcome.status !== "planned") throw new Error("Expected a draft plan");
    expect(yield* guardInterviewConfirmation(root, outcome.plan, Effect.succeed(false))).toBe(false);
    expect(yield* fs.readFileString(target)).toBe(original);
    const confirmation = fs.writeFileString(target, edited).pipe(Effect.as(true));
    const staleAfter = yield* Effect.flip(guardInterviewConfirmation(root, outcome.plan, confirmation));
    expect(staleAfter.message).toBe("A planned destination changed during confirmation. Run setup again.");
    expect(yield* fs.readFileString(target)).toBe(edited);
    const staleBefore = yield* Effect.flip(guardInterviewConfirmation(root, outcome.plan, Effect.dieMessage("Stale draft must not prompt")));
    expect(staleBefore.message).toBe("The profile text changed during the interview. Run setup again.");
  }));
});

test("quitting a follow-up only checkpoints the accepted human answer", async () => {
  const fact = "I work on synthetic public data systems.";
  const { io } = human([fact, "quit"]);
  const checkpoints: Answers[] = [];

  const error = await run(Effect.gen(function* () {
    const resources = yield* withResources;

    return yield* Effect.flip(runInterviewSession({ ...resources, answers: {}, providedKeys: new Set(), io: new BudgetedInterviewIO(io),
      interactive: true, mode: "guided", guided: select(() => Effect.succeed({ text: reply("current_role", 0) })),
      checkpoint: (facts) => Effect.sync(() => { checkpoints.push(facts); }) }));
  }));

  expect(error).toEqual(new InterviewCancelled({ message: "Interview cancelled." }));
  expect(checkpoints).toEqual([{ interview_current_role: fact }]);
});

test("oversized context never reaches the invocation boundary", async () => {
  const { io, said } = human(["later"]);

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;
    const guided = select(() => Effect.dieMessage("Oversized context must not be sent"));

    return yield* runInterviewSession({ ...resources, answers: recordedAnswers, providedKeys: knownKeys, io: new BudgetedInterviewIO(io),
      interactive: true, mode: "guided", guided, existingText: "å".repeat(64 * 1024) });
  }));

  expect(result).toMatchObject({ status: "later", invocations: 0 });
  expect(said).toContain("The interview context is too large or invalid. It was not truncated.");
});

test("rejects oversized response text, including whitespace that does not change its object", async () => {
  const { io, said } = human(["later"]);

  const result = await run(Effect.gen(function* () {
    const resources = yield* withResources;
    const guided = select(() => Effect.succeed({ text: reply("current_role") + " ".repeat(16 * 1024) }));

    return yield* runInterviewSession({ ...resources, answers: recordedAnswers, providedKeys: knownKeys, io: new BudgetedInterviewIO(io), interactive: true, mode: "guided", guided });
  }));

  expect(result).toMatchObject({ status: "later", invocations: 1 });
  expect(said).toContain("The guided interview could not continue. No AI text was saved.");
});

test("a file created during the guided collection blocks the draft plan before display", async () => {
  const { io, said } = human([]);
  await run(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = join(root, "custom.md");
    const responses = recordedResponses.values();

    const selection: GuidedInterview<never> = { executable: "synthetic-pi", reviewer, callTurn: () => Effect.gen(function* () {
      const next = responses.next();

      if (next.done) return yield* Effect.dieMessage("Unexpected extra interview call");

      if (next.value.question_id === "current_role") yield* fs.writeFileString(target, "An independently created profile.").pipe(Effect.orDie);

      return { text: JSON.stringify(next.value) };
    }) };

    const error = yield* Effect.flip(runInterviewStep({ ...script(root, io), narrativePath: "custom.md", selectGuided: Effect.succeed(selection) }));
    expect(error.message).toBe("The profile text changed during the interview. Run setup again.");
    expect(said).not.toContain("Profile draft (not saved):");
  }));
});
