import { Effect, Either, Option, Predicate } from "effect";
import { TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import { parseIsoDate } from "../lib/contracts/iso-time.ts";
import { dateToken } from "../lib/server/profile/core.ts";
import { isScheduleConfigTable, rewriteScheduleConfig } from "../lib/server/profile/schedule-config.ts";
import { normalize, normalizeUserTime, parsePeriod, parsePeriodInput, parseUserPeriod, validatePeriod, type Period } from "../lib/server/profile/schedule-period.ts";
import { caseFold } from "../lib/server/shared/text.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { askInitText, InitInputError, initQuestions, type InitInputs } from "./init-prompts.ts";
import type { InterviewIO } from "./interview-session.ts";

const scheduleError = (message: string) => new InitInputError({ message });
const quick = ["daily", "weekly", "every 2 weeks", "never"] as const;
const choices = [...quick, "monthly", "every n days", "every n weeks"] as const;
const numbered = new Map(choices.map((choice, index) => [String(index + 1), choice]));

type Choice = typeof choices[number] | "other";

const isChoice = (text: string): text is Choice => text === "other" || choices.some((choice) => choice === text);
const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const editedKeys = ["schedule_choice", "schedule_period", "schedule_weekday", "schedule_time", "schedule_day", "schedule_count", "schedule_anchor"];
const recoveryKeys = [...editedKeys, "schedule_normalized"];

const choiceFor = (period: Period | null): Choice => {
  if (!period) return "never";

  if (period.kind === "every_n_weeks") return period.n === 2 ? "every 2 weeks" : "every n weeks";

  if (period.kind === "every_n_days") return "every n days";

  return period.kind;
};

const sameInterval = (a: Period, b: Period): boolean => a.kind === b.kind && a.n === b.n && a.weekday === b.weekday;

const withAnchor = (period: Period, value: TomlValue, message: string) => Either.gen(function* () {
  if (!Predicate.isString(value) && !Predicate.isBigInt(value) && !(value instanceof TomlDate && value.isDate())) {
    return yield* Either.left(scheduleError(message));
  }

  const date = parseIsoDate(dateToken(value));

  if (Option.isNone(date)) return yield* Either.left(scheduleError(message));

  return yield* Either.mapLeft(validatePeriod({ ...period, anchor: date.value.text }), () => scheduleError(message));
});

const savedAnchor = (period: Period | null, value: TomlValue | undefined) => Either.gen(function* () {
  if (!period || period.anchor === null || value === undefined) return null;

  return (yield* withAnchor(period, value, "Invalid saved schedule anchor.")).anchor;
});

const bounded = (maximum: number) => (value: string): string | null =>
  /^[0-9]+$/.test(value) && Number(value) >= 1 && Number(value) <= maximum ? null : `Enter a number from 1 to ${maximum}.`;

const validTime = (text: string) => Either.isLeft(normalizeUserTime(text)) ? "Use a real HH:MM time." : null;

interface ScheduleInput {
  readonly profileId: string;
  readonly configText: string;
  readonly configExists: boolean;
  readonly osloDate: string;
  readonly recordAccepted?: (key: GuidedAnswer | "schedule_choice", value: string) => Effect.Effect<void>;
}

type GuidedAnswer = "schedule_confirm" | "schedule_day" | "schedule_count" | "schedule_time" | "schedule_weekday";

export type ScheduleRecoveryAnswers = Readonly<Partial<Record<GuidedAnswer, string>> & {
  schedule_choice: Choice;
  schedule_normalized: string;
  // Null means remove this key from the caller's recovery answers.
  schedule_anchor: string | null;
}>;

export type SchedulePlan = ({ readonly kind: "kept" } | { readonly kind: "planned"; readonly configText: string }) & {
  readonly recoveryAnswers: ScheduleRecoveryAnswers;
};

const readSavedSchedule = (config: TomlTable, osloDate: string) => Effect.gen(function* () {
  const saved = config.schedule ?? {};
  const policy = config.policy ?? {};

  if (!isScheduleConfigTable(saved) || !isScheduleConfigTable(policy)) return yield* scheduleError("Cannot safely edit this profile representation.");

  const expression = saved.schedule ?? (policy.cadence === "fortnightly" ? "every 2 weeks fri 09:00" : "weekly fri 09:00");
  const period = expression === "never" ? null : yield* parsePeriodInput({ text: expression, today: osloDate });

  return { expression, period, anchor: saved.anchor ?? policy.cadence_anchor };
});

export const setupScheduleDefaults = (config: TomlTable, osloDate: string) => Effect.gen(function* () {
  const saved = yield* readSavedSchedule(config, osloDate);
  const { period, expression } = saved;
  const answers: TomlTable = { schedule_choice: choiceFor(period) };

  if (!period) return answers;

  answers.schedule_period = expression;
  answers.schedule_normalized = yield* normalize(period);
  answers.schedule_time = period.time;

  if (period.day_of_month !== null) answers.schedule_day = String(period.day_of_month);

  if (period.anchor !== null) answers.schedule_count = String(period.n);

  if (period.weekday !== null) {
    const weekday = weekdays[period.weekday];

    if (weekday !== undefined) answers.schedule_weekday = weekday;
  }

  const anchor = yield* savedAnchor(period, saved.anchor);

  if (anchor !== null) answers.schedule_anchor = anchor;

  return answers;
});

// The caller supplies the selected profile and Oslo date. No setup state is
// changed until the caller accepts the plan and merges its named updates.
export const planSetupSchedule = (io: InterviewIO, inputs: InitInputs, input: ScheduleInput) => Effect.gen(function* () {
  const { profileId, configText, configExists, osloDate } = input;
  const ctx = initQuestions(io, { ...inputs, answers: { ...inputs.answers } });
  const config = yield* parseToml(configText);
  const { expression, period: savedPeriod, anchor: savedAnchorValue } = yield* readSavedSchedule(config, osloDate);
  const guided: Partial<Record<GuidedAnswer, string>> = {};

  const recoveryAnswers = (choice: Choice, normalized: string, anchor: string | null): ScheduleRecoveryAnswers => ({
    ...guided, schedule_choice: choice, schedule_normalized: normalized, schedule_anchor: anchor,
  });

  const kept = (choice: Choice, normalized: string, anchor: string | null): SchedulePlan => ({
    kind: "kept", recoveryAnswers: recoveryAnswers(choice, normalized, anchor),
  });

  yield* ctx.say("1. Daily\n2. Weekly\n3. Every two weeks\n4. No automatic runs");

  if (ctx.advanced) yield* ctx.say("5. Monthly\n6. Every N days\n7. Every N weeks");

  const recovered = ctx.current("schedule_normalized");
  let reference = savedPeriod;

  if (ctx.recoveredKeys.has("schedule_normalized") && Predicate.isString(recovered)) {
    reference = recovered === "never" ? null : yield* parsePeriod(recovered, osloDate);
  }

  const changed = editedKeys.some(ctx.inputChanged);
  const pendingRecovery = recoveryKeys.some((key) => ctx.recoveredKeys.has(key) && ctx.inputChanged(key));
  const savedChoice = ctx.current("schedule_choice");

  const partialChoice = pendingRecovery && !ctx.recoveredKeys.has("schedule_normalized") && ctx.recoveredKeys.has("schedule_choice") &&
    Predicate.isString(savedChoice) && isChoice(savedChoice) && savedChoice !== "other" ? savedChoice : undefined;

  if (reference) yield* ctx.say(`Current schedule: ${yield* normalize(reference)} (Norway time).`);
  else yield* ctx.say("No automatic runs");

  if (partialChoice) yield* ctx.say(`Pending schedule choice: ${partialChoice}.`);
  let choice: string;

  if (ctx.nonInteractive || (changed && (!pendingRecovery || ctx.explicitKeys.has("schedule_choice")))) {
    const provided = ctx.current("schedule_choice") ?? choiceFor(reference);

    if (!Predicate.isString(provided)) return yield* scheduleError("Answer schedule_choice must be text.");
    choice = provided;

    // Old recovery projected custom periods to 'other'; only named raw input
    // retains that route. The interactive menu stays guided.
    if (choice === "other" && !ctx.explicitKeys.has("schedule_choice") && !ctx.explicitKeys.has("schedule_period")) {
      const raw = ctx.current("schedule_period");

      if (Predicate.isString(raw) && ctx.recoveredKeys.has("schedule_period")) reference = yield* parseUserPeriod(raw, osloDate);
      choice = choiceFor(reference);
    }
  } else {
    choice = yield* askInitText(io, {
      prompt: "Choose a number, or keep the current schedule",
      default: "keep",
      validate: (text) => text === "keep" || (numbered.has(text) && (ctx.advanced || Number(text) <= 4)) || quick.some((item) => item === text)
        ? null : "Choose a displayed number.",
    });
  }

  choice = numbered.get(choice) ?? choice;

  if (choice === "keep" && pendingRecovery) choice = partialChoice ?? choiceFor(reference);

  if (choice === "keep") {
    const normalized = savedPeriod ? yield* normalize(savedPeriod) : "never";
    const anchor = yield* savedAnchor(savedPeriod, savedAnchorValue);

    yield* ctx.say("Keeping the saved schedule. Nothing is started.");

    return kept(choiceFor(savedPeriod), normalized, anchor);
  }

  if (!isChoice(choice)) return yield* scheduleError("Invalid schedule choice.");

  if (input.recordAccepted) yield* input.recordAccepted("schedule_choice", choice);

  const answer = (key: GuidedAnswer, prompt: string, fallback: string, validate: (text: string) => string | null) => Effect.gen(function* () {
    if (key !== "schedule_confirm" && !ctx.explicitKeys.has(key) && !ctx.recoveredKeys.has(key)) ctx.answers[key] = fallback;
    const value = yield* ctx.answer(key, { prompt, default: fallback, validate });

    guided[key] = value;

    if (input.recordAccepted) yield* input.recordAccepted(key, value);

    return value;
  });

  let period: Period | null = null;

  if (choice === "other") {
    const raw = ctx.current("schedule_period");

    if (!Predicate.isString(raw)) return yield* scheduleError("Named other requires schedule_period text.");
    period = yield* parseUserPeriod(raw, osloDate);

    const confirm = caseFold(yield* answer("schedule_confirm", "Use this period?", "yes", (text) =>
      ["yes", "y", "no", "n"].includes(caseFold(text)) ? null : "Answer yes or no."));

    if (confirm !== "yes" && confirm !== "y") return yield* scheduleError("Schedule was not confirmed.");
  } else if (choice !== "never") {
    let prefix: string = choice;

    if (choice === "monthly") {
      const day = yield* answer("schedule_day", "Day of month (1-28)", String(reference?.day_of_month ?? 1), bounded(28));
      prefix = `monthly ${day}`;
    }

    if (choice === "every n days" || choice === "every n weeks") {
      const days = choice === "every n days";
      const maximum = days ? 90 : 52;
      const count = yield* answer("schedule_count", `Interval (1-${maximum})`, String(reference?.kind === (days ? "every_n_days" : "every_n_weeks") ? reference.n : 2), bounded(maximum));
      prefix = `every ${count} ${days ? "days" : "weeks"}`;
    }

    if (choice === "weekly" || choice === "every 2 weeks" || choice === "every n weeks") {
      const weekday = yield* answer("schedule_weekday", "Weekday", weekdays[reference?.weekday ?? 4] ?? "friday", (text) =>
        Either.isLeft(parsePeriod(`weekly ${text} 09:00`, osloDate)) ? "Choose a valid weekday." : null);

      prefix += ` ${weekday}`;
    }

    const time = yield* answer("schedule_time", "Time (HHMM or HH:MM, Norway time)", reference?.time ?? "09:00", validTime);
    period = yield* parsePeriod(`${prefix} ${yield* normalizeUserTime(time)}`, osloDate);
  }

  const normalized = period ? yield* normalize(period) : "never";
  const savedNormalized = savedPeriod ? yield* normalize(savedPeriod) : "never";

  if (period && period.anchor !== null) {
    let anchor: TomlValue | undefined;

    if (ctx.explicitKeys.has("schedule_anchor")) {
      anchor = ctx.current("schedule_anchor");

      if (anchor === undefined) return yield* scheduleError("Invalid schedule anchor.");
    } else if (Predicate.isString(recovered) && recovered !== "never" && ctx.recoveredKeys.has("schedule_anchor")) {
      const recoveredPeriod = yield* parsePeriod(recovered, osloDate);

      if (sameInterval(recoveredPeriod, period)) anchor = ctx.current("schedule_anchor");
    }

    if (anchor === undefined && savedPeriod && sameInterval(savedPeriod, period)) {
      anchor = (yield* savedAnchor(savedPeriod, savedAnchorValue)) ?? undefined;

      if (anchor === undefined) {
        if (normalized === savedNormalized) {
          yield* ctx.say("Keeping the saved schedule. Its interval anchor is unknown; nothing is started.");

          return kept(choice, savedNormalized, null);
        }

        return yield* scheduleError("The saved interval has no known anchor; choose a different interval before editing.");
      }
    }

    if (anchor === undefined) yield* ctx.say(`Interval anchor resolved to ${period.anchor} (Norway date).`);
    else period = yield* withAnchor(period, anchor, "Invalid schedule anchor.");
  }

  if (period) {
    guided.schedule_time = period.time;
    yield* ctx.say(`Schedule: ${normalized}`);
  }

  const anchor = period?.anchor ?? null;

  if ((!period && expression === "never") || ((configExists || Object.hasOwn(config, "schedule")) && period && savedPeriod &&
    normalized === savedNormalized && (anchor === null || (yield* savedAnchor(savedPeriod, savedAnchorValue)) === anchor))) {
    yield* ctx.say("Keeping the saved schedule. Nothing is started.");

    return kept(choice, normalized, anchor);
  }

  const cadence = period?.kind === "weekly" ? "weekly" : period?.kind === "every_n_weeks" && period.n === 2 ? "fortnightly" : null;
  const updated = yield* Either.mapLeft(rewriteScheduleConfig(configText, normalized, anchor, cadence), (error) => scheduleError(error.message));

  yield* ctx.say("This saves your choice. It does not start anything yet.");

  if (period) yield* ctx.say(`To install later: pulse --root PATH --profile ${profileId} schedule install (replace PATH with your Pulse root)`);

  return { kind: "planned", configText: updated, recoveryAnswers: recoveryAnswers(choice, normalized, anchor) } satisfies SchedulePlan;
});
