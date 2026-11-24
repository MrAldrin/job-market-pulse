import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { Either } from "effect";
import { nextRuns, normalize, onCalendar, type Period } from "../profile/schedule-period.ts";

// The caller must resolve the installation root, including symlinks, before rendering.
export const unitNames = (resolvedRoot: string, profileId: string): readonly [string, string] => {
  if (!isAbsolute(resolvedRoot)) throw new Error("The installation root must be absolute");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profileId)) throw new Error("Unsafe profile ID");
  const digest = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 8);
  const stem = `job-market-pulse-${profileId}-${digest}`;

  return [`${stem}.service`, `${stem}.timer`];
};

const quote = (value: string, exec = false): string => {
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("Unit arguments cannot contain control characters");
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");

  if (exec) escaped = escaped.replaceAll("$", () => "$$");

  return `"${escaped}"`;
};

const unwrap = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) throw value.left;

  return value.right;
};

export interface ScheduleRenderInput {
  readonly period: Period;
  readonly resolvedRoot: string;
  readonly profileId: string;
  readonly command: readonly string[];
  readonly searchPath?: string | undefined;
}

export interface ScheduleUnits {
  readonly [unitName: string]: string;
}

export const renderUnits = ({ period, resolvedRoot, profileId, command, searchPath }: ScheduleRenderInput): ScheduleUnits => {
  const [service, timer] = unitNames(resolvedRoot, profileId);

  if (!command.length || !isAbsolute(command[0] ?? "")) throw new Error("The executable must be an absolute path");
  const arguments_ = [...command];
  let expression = unwrap(onCalendar(period));

  if (expression === null) {
    const base: Period = period.kind === "every_n_weeks"
      ? { ...period, kind: "weekly", n: 1, anchor: null }
      : { ...period, kind: "daily", n: 1, anchor: null };

    expression = unwrap(onCalendar(base));
    arguments_.push("--only-if-due", "--period", unwrap(normalize(period)), "--anchor", period.anchor ?? "None");
  }

  const environment = searchPath === undefined ? "" : `Environment=${quote(`PATH=${searchPath}`)}\n`;

  return {
    [service]: `[Unit]\nDescription=Job Market Pulse scheduled run\n\n[Service]\nType=oneshot\nWorkingDirectory=${quote(resolvedRoot)}\nUMask=0077\nTimeoutStartSec=3600\n${environment}ExecStart=${arguments_.map((arg) => quote(arg, true)).join(" ")}\n`,
    [timer]: `[Unit]\nDescription=Job Market Pulse schedule\n\n[Timer]\nUnit=${service}\nOnCalendar=${expression} Europe/Oslo\nPersistent=true\nRandomizedDelaySec=300\n\n[Install]\nWantedBy=timers.target\n`,
  };
};

export const showSchedule = (input: ScheduleRenderInput, after: string): string => {
  const sections = Object.entries(renderUnits(input)).map(([name, text]) => `# ${name}\n${text}`);

  return [...sections, "Next three run times (before randomized delay):", ...unwrap(nextRuns(input.period, after)), "Nothing was installed."].join("\n");
};
