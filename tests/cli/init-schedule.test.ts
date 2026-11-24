import { readFileSync } from "node:fs";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { planSetupSchedule } from "../../src/cli/init-schedule.ts";
import type { InitInputs } from "../../src/cli/init-prompts.ts";
import type { InterviewIO } from "../../src/cli/interview-session.ts";

// Profile draft emitted by frozen init_step_profile.py for this fresh selection.
const draft = `[profile]
id = "invented"

[paths]
profile = "profile.md"
preferences = "preferences.toml"
source_db = "data/nav.sqlite3"
review_db = "review.sqlite3"
ledger_db = "ledger.sqlite3"
outbox = "outbox"

[policy]
mode = "passive"
market_only = false
freshness_max_age_hours = 24
`;

const scheduled = (text: string, anchor?: string) => `${draft}\n[schedule]\nschedule = "${text}"\n${anchor ? `anchor = "${anchor}"\n` : ""}`;
const osloDate = "2026-03-21";

const ioTape = (replies: readonly string[]) => {
  const said: string[] = [];
  const questions: string[] = [];
  const next = replies[Symbol.iterator]();

  const io: InterviewIO = {
    ask: (text) => Effect.sync(() => {
      questions.push(text);
      const reply = next.next();

      if (reply.done) throw new Error(`Unexpected question: ${text}`);

      return reply.value;
    }),
    say: (text) => Effect.sync(() => { said.push(text); }),
  };

  return { said, questions, io };
};

const start = (options: Partial<InitInputs> = {}, replies: readonly string[] = [], configText = draft, configExists = configText !== draft) => {
  const inputs: InitInputs = {
    answers: {}, explicitKeys: new Set(), recoveredKeys: new Set(), nonInteractive: false,
    committedDefaults: {}, advanced: false, recoveryStep: "schedule", ...options,
  };

  const tape = ioTape(replies);
  const result = Effect.runSync(Effect.either(planSetupSchedule(tape.io, inputs, { configText, configExists, profileId: "invented", osloDate })));

  return { ...tape, result };
};

const explicit = (answers: InitInputs["answers"], nonInteractive = true): Partial<InitInputs> => ({
  answers, nonInteractive, explicitKeys: new Set(Object.keys(answers)),
});

const plannedText = (run: ReturnType<typeof start>): string => {
  if (Either.isLeft(run.result)) throw run.result.left;

  if (run.result.right.kind !== "planned") throw new Error("Expected schedule edit.");

  return run.result.right.configText;
};

describe("setup schedule", () => {
  it("matches the frozen setup-interview schedule stdout slice and scheduled profile bytes", () => {
    const oracle = new URL("../oracle/setup-interview/", import.meta.url);
    const fixture = new URL("../fixtures/port-oracle/setup-interview/inputs/answers.json", import.meta.url);
    const answers = JSON.parse(readFileSync(fixture, "utf8"));
    const recorded: { stdout: string } = JSON.parse(readFileSync(new URL("cli/init.json", oracle), "utf8"));
    const expected = recorded.stdout.split("6/7  Schedule\n")[1]?.split("7/7  Summary\n")[0];
    const run = start(explicit(answers));

    expect(run.said.join("\n") + "\n").toBe(expected);
    expect(Buffer.from(plannedText(run))).toEqual(readFileSync(new URL("setup/files/profiles/invented/profile.toml", oracle)));
    expect(run.questions).toEqual([]);
  });

  it.each([
    ["1", ["1600"], "daily 16:00", undefined],
    ["2", ["mandag", "1600"], "weekly mon 16:00", undefined],
    ["3", ["monday", "1600"], "every 2 weeks mon 16:00", "2026-03-23"],
    ["4", [], "never", undefined],
    ["5", ["28", "1600"], "monthly 28 16:00", undefined],
    ["6", ["90", "1600"], "every 90 days 16:00", osloDate],
    ["7", ["52", "monday", "1600"], "every 52 weeks mon 16:00", "2026-03-23"],
  ] as const)("plans guided choice %s with normalized time and Oslo anchor", (choice, replies, expression, anchor) => {
    const run = start({ advanced: true }, [choice, ...replies]);
    const config = parse(plannedText(run));

    expect(config.schedule).toEqual(anchor ? { schedule: expression, anchor } : { schedule: expression });
    expect(config.policy).toMatchObject({ mode: "passive", freshness_max_age_hours: 24 });
    expect(run.said).toContain("This saves your choice. It does not start anything yet.");
    expect(run.said.some((line) => line.startsWith("To install later:"))).toBe(choice !== "4");

    if (choice === "3") expect(config.policy).toMatchObject({ cadence: "fortnightly", cadence_anchor: anchor });

    if (choice === "2") expect(config.policy).toMatchObject({ cadence: "weekly" });
  });

  it("retries quick menu, weekday, clock and advanced bounds with frozen prompts", () => {
    const quick = start({}, ["5", "other", "2", "noday", "mandag", "25:00", "9:00", "10:15"]);

    expect(quick.questions[0]).toBe("Choose a number, or keep the current schedule (current: keep; press Enter to keep it): ");
    expect(quick.questions[3]).toBe("Weekday (current: friday; press Enter to keep it): ");
    expect(quick.said.filter((line) => line === "Choose a displayed number.")).toHaveLength(2);
    expect(quick.said).toContain("Choose a valid weekday.");
    expect(quick.said.filter((line) => line === "Use a real HH:MM time.")).toHaveLength(2);
    expect(parse(plannedText(quick)).schedule).toEqual({ schedule: "weekly mon 10:15" });

    for (const [choice, invalid, valid, tail, maximum] of [
      ["5", "29", "28", ["1600"], 28],
      ["6", "91", "90", ["1600"], 90],
      ["7", "53", "52", ["monday", "1600"], 52],
    ] as const) {
      const run = start({ advanced: true }, [choice, invalid, "0", valid, ...tail]);

      expect(run.said.filter((line) => line === `Enter a number from 1 to ${maximum}.`)).toHaveLength(2);
      expect(run.result._tag).toBe("Right");
    }

    expect(start({}, ["5", "6", "7"]).result).toMatchObject({ left: { message: "Too many invalid answers." } });
    expect(start({}, ["quit"]).result).toMatchObject({ left: { message: "Setup cancelled." } });
  });

  it("uses projected defaults and accepts named raw periods only with confirmation", () => {
    const answers = { schedule_choice: "other", schedule_period: "every 3 days 0812", schedule_confirm: "Y" };
    const run = start(explicit(answers));

    expect(parse(plannedText(run)).schedule).toEqual({ schedule: "every 3 days 08:12", anchor: osloDate });
    expect(run.result).toMatchObject({ right: { recoveryAnswers: { schedule_choice: "other", schedule_confirm: "Y", schedule_time: "08:12" } } });
    expect(answers).toEqual({ schedule_choice: "other", schedule_period: "every 3 days 0812", schedule_confirm: "Y" });
    expect(start(explicit({ ...answers, schedule_confirm: "no" })).result).toMatchObject({ left: { message: "Schedule was not confirmed." } });
    expect(start(explicit({ schedule_choice: "other", schedule_period: "daily" })).result).toMatchObject({ left: { key: "schedule_confirm" } });
    expect(start(explicit({ schedule_choice: "other" })).result).toMatchObject({ left: { message: "Named other requires schedule_period text." } });
    expect(start(explicit({ schedule_choice: "daily", schedule_time: "2460" })).result).toMatchObject({ left: { message: "Answer schedule_time is invalid. Use a real HH:MM time." } });
    expect(start(explicit({ schedule_choice: "daily" })).result).toMatchObject({ right: { recoveryAnswers: { schedule_time: "09:00" } } });
    expect(start(explicit({ schedule_choice: "5" })).result).toMatchObject({ right: { recoveryAnswers: { schedule_normalized: "monthly 1 09:00" } } });
  });

  it("keeps opaque saved bytes for Enter and semantically unchanged aliases", () => {
    const original = `${scheduled("fortnightly fre 16:00", "20260102")}\n[opaque]\nvalue = """æøå\n[schedule]\nschedule = 'never'\n"""`.replaceAll("\n", "\r\n");
    const run = start({}, [""], original);
    const named = start(explicit({ schedule_choice: "3", schedule_weekday: "friday", schedule_time: "1600" }), [], original);

    for (const attempt of [run, named]) {
      expect(attempt.result).toMatchObject({ right: { kind: "kept", recoveryAnswers: { schedule_choice: "every 2 weeks", schedule_normalized: "every 2 weeks fri 16:00", schedule_anchor: "2026-01-02" } } });
      expect(attempt.said).toContain("Keeping the saved schedule. Nothing is started.");
    }

    expect(start(explicit({ schedule_choice: "2" }), [], draft, true).result).toMatchObject({ right: { kind: "kept" } });
    expect(start(explicit({ schedule_choice: "2" }), [], draft, false).result).toMatchObject({ right: { kind: "planned" } });
    expect(start(explicit({ schedule_choice: "4" }), [], scheduled("never")).result).toMatchObject({ right: { kind: "kept", recoveryAnswers: { schedule_anchor: null } } });
  });

  it("retains same-cadence committed phase; re-anchors count or weekday edits", () => {
    const text = scheduled("every 3 weeks mon 09:00", "2026-01-05");
    const run = (answers: InitInputs["answers"]) => parse(plannedText(start(explicit(answers), [], text))).schedule;

    expect(run({ schedule_time: "1600" })).toEqual({ schedule: "every 3 weeks mon 16:00", anchor: "2026-01-05" });
    expect(run({ schedule_count: "4" })).toEqual({ schedule: "every 4 weeks mon 09:00", anchor: "2026-03-23" });
    expect(run({ schedule_weekday: "tuesday" })).toEqual({ schedule: "every 3 weeks tue 09:00", anchor: "2026-03-24" });
    expect(run({ schedule_anchor: "2026-W01-1" })).toEqual({ schedule: "every 3 weeks mon 09:00", anchor: "2025-12-29" });
    expect(start(explicit({ schedule_anchor: "2026-01-06" }), [], text).result).toMatchObject({ left: { message: "Invalid schedule anchor." } });
  });

  it("uses legacy phase fallback without inventing an unknown saved phase", () => {
    const legacy = `${draft}cadence = "fortnightly"\ncadence_anchor = 2000-01-07\n`;

    expect(start({}, [""], legacy).result).toMatchObject({ right: { kind: "kept", recoveryAnswers: { schedule_anchor: "2000-01-07" } } });
    expect(parse(plannedText(start(explicit({ schedule_time: "1600" }), [], legacy))).schedule).toEqual({ schedule: "every 2 weeks fri 16:00", anchor: "2000-01-07" });
    const invalidLegacy = legacy.replace("2000-01-07", "2000-01-06");

    expect(start({}, [""], invalidLegacy).result).toMatchObject({ left: { message: "Invalid saved schedule anchor." } });
    const ownAnchor = `${invalidLegacy}\n[schedule]\nschedule = "every 2 weeks fri 09:00"\nanchor = 2000-01-07\n`;

    expect(start({}, [""], ownAnchor).result).toMatchObject({ right: { kind: "kept", recoveryAnswers: { schedule_anchor: "2000-01-07" } } });
    const unknown = scheduled("every 3 days 09:00");
    const equivalent = start(explicit({ schedule_time: "0900" }), [], unknown);

    expect(equivalent.result).toMatchObject({ right: { kind: "kept", recoveryAnswers: { schedule_anchor: null } } });
    expect(equivalent.said.at(-1)).toBe("Keeping the saved schedule. Its interval anchor is unknown; nothing is started.");
    expect(start(explicit({ schedule_time: "1600" }), [], unknown).result).toMatchObject({ left: { message: expect.stringContaining("no known anchor") } });
    expect(parse(plannedText(start(explicit({ schedule_anchor: 20260101n, schedule_time: "1600" }), [], unknown))).schedule).toEqual({ schedule: "every 3 days 16:00", anchor: "2026-01-01" });
  });

  it("offers the draft cadence menu on resume and uses recovered phase only for the same cadence", () => {
    const answers = { schedule_choice: "every n weeks", schedule_normalized: "every 3 weeks mon 16:00", schedule_anchor: "2026-02-02", schedule_count: "3", schedule_time: "16:00" };
    const recovery = { answers, recoveredKeys: new Set(Object.keys(answers)) };
    const text = scheduled("every 3 weeks mon 09:00", "2026-01-05");
    const resume = start(recovery, ["", "", "", ""], text);
    const changed = start({ ...recovery, ...explicit({ ...answers, schedule_count: "4" }), explicitKeys: new Set(["schedule_count"]) }, [], text);
    const explicitAnchor = start({ ...recovery, ...explicit({ ...answers, schedule_anchor: "2025-12-01" }), explicitKeys: new Set(["schedule_anchor"]) }, [], text);

    expect(resume.questions[0]).toContain("Choose a number");
    expect(resume.said).toContain("Current schedule: every 3 weeks mon 16:00 (Norway time).");
    expect(parse(plannedText(resume)).schedule).toEqual({ schedule: "every 3 weeks mon 16:00", anchor: "2026-02-02" });
    expect(parse(plannedText(changed)).schedule).toEqual({ schedule: "every 4 weeks mon 16:00", anchor: "2026-03-23" });
    expect(parse(plannedText(explicitAnchor)).schedule).toEqual({ schedule: "every 3 weeks mon 16:00", anchor: "2025-12-01" });
    expect(parse(plannedText(start(recovery, ["4"], text))).schedule).toEqual({ schedule: "never" });
    const named = start({ ...recovery, answers: { ...answers, schedule_choice: "4" }, explicitKeys: new Set(["schedule_choice"]) }, [], text);

    expect(parse(plannedText(named)).schedule).toEqual({ schedule: "never" });
    expect(named.questions).toEqual([]);
  });

  it("projects old recovered 'other' values but accepts explicit raw edits", () => {
    const answers = { schedule_choice: "other", schedule_period: "every 3 days 1600", schedule_anchor: "2026-01-05" };
    const run = start({ answers, recoveredKeys: new Set(Object.keys(answers)), nonInteractive: true }, [], scheduled("daily 09:00"));

    expect(parse(plannedText(run)).schedule).toEqual({ schedule: "every 3 days 16:00", anchor: osloDate });
    expect(run.questions).toEqual([]);
  });

  it.each(["\n", "\r\n"])("preserves unknown fields, comments and final line endings (%j)", (newline) => {
    const extras = '[opaque]\nname = "æøå" # preserve\ndate = 2026-01-01\nvalue = { x = [1, 2], y = true }';
    const original = `${draft}cadence = "fortnightly"\ncadence_anchor = "2000-01-07"\n\n[schedule] # preserve\nschedule = "fortnightly fri 09:00" # owned line\nunknown = 1.0 # preserve\n\n${extras}`;

    for (const tail of ["", "\n"]) {
      const text = (original + tail).replaceAll("\n", newline);

      const expected = (original.replace('cadence = "fortnightly"\ncadence_anchor = "2000-01-07"\n', "")
        .replace('schedule = "fortnightly fri 09:00" # owned line', 'schedule = "daily 16:00"\n# owned line') + tail).replaceAll("\n", newline);

      expect(plannedText(start(explicit({ schedule_choice: "daily", schedule_time: "1600" }), [], text))).toBe(expected);
      const lastOwned = `${draft}\n[schedule]\nschedule = "daily 09:00"${tail}`.replaceAll("\n", newline);

      expect(plannedText(start(explicit({ schedule_time: "1600" }), [], lastOwned))).toBe(lastOwned.replace("09:00", "16:00"));
    }
  });

  it.each(["\n", "\r\n"])("keeps the last schedule comment without a final newline (%j)", (newline) => {
    const original = `${draft}\n[schedule]\n  schedule = "every 2 weeks fri 09:00" # keep this\nanchor = "2026-11-13"`.replaceAll("\n", newline);
    const expected = `${draft}\n[schedule]\nschedule = "never"\n  # keep this`.replaceAll("\n", newline);

    expect(plannedText(start(explicit({ schedule_choice: "4" }), [], original))).toBe(expected);
  });

  it.each(["\n", "\r\n"])("preserves Unicode line separators within TOML comments (%j)", (newline) => {
    const original = `${draft}# preserve\u2029cadence = comment text\n\n[schedule]\nschedule = "daily 09:00"\n# preserve\u2028anchor = comment text\n`.replaceAll("\n", newline);
    const updated = plannedText(start(explicit({ schedule_time: "1600" }), [], original));

    expect(Buffer.from(updated)).toEqual(Buffer.from(original.replace("09:00", "16:00")));
  });

  it.each([
    `${draft}\n["schedule"]\nschedule = "daily"\n`,
    `${draft}\n[schedule]\n"schedule" = "daily"\n`,
    `schedule = { schedule = "daily" }\n${draft}`,
    `${draft}\n[opaque]\nvalue = """\n[schedule]\n"""\n`,
    `${draft}\r\n[schedule]\r\nschedule = "daily"\r\n`,
    `${scheduled("daily")}\n[opaque]\nextra = { values = [nan] }\n`,
  ])("refuses ambiguous edits without changing named answers", (text) => {
    const answers = { schedule_choice: "daily", schedule_time: "1600" };
    const run = start(explicit(answers), [], text);

    expect(run.result).toMatchObject({ left: { message: expect.stringContaining("Cannot safely") } });
    expect(answers).toEqual({ schedule_choice: "daily", schedule_time: "1600" });
    expect(run.said).not.toContain("This saves your choice. It does not start anything yet.");
  });
});
