import { Either, Predicate } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { TomlTable, TomlValue } from "smol-toml";
import { pythonSpaceClass, strip } from "../shared/text.ts";
import { parseToml } from "../shared/toml.ts";
import { PeriodError } from "./errors.ts";

const scheduleError = (message: string) => new PeriodError({ message });

export const isScheduleConfigTable = (value: TomlValue | undefined): value is TomlTable =>
  Predicate.isRecord(value) && !(value instanceof Date);

// Separate tomllib parses produce distinct NaNs, which make the frozen
// round-trip comparison fail even when the corresponding bytes are unchanged.
const containsNaN = (value: TomlValue): boolean => {
  if (Array.isArray(value)) return value.some(containsNaN);

  if (isScheduleConfigTable(value)) return Object.values(value).some(containsNaN);

  return Number.isNaN(value);
};

type Section = "schedule" | "policy";

const header = new RegExp(`^\\[(schedule|policy)\\]${pythonSpaceClass}*(?:#[\\s\\S]*)?$`, "u");
const assignment = new RegExp(`^(${pythonSpaceClass}*)(schedule|anchor|cadence|cadence_anchor)${pythonSpaceClass}*=`, "u");

const keepComment = (line: string, indent: string): string => {
  // The input TOML has already parsed, and multiline strings are excluded.
  // Skip quoted values, including escaped quotes, before finding a comment.
  const tokens = line.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|#[^\r\n]*/g);
  const comment = Array.from(tokens).find(([token]) => token.startsWith("#"))?.[0];

  return comment === undefined ? "" : indent + comment + (line.match(/\r?\n$/)?.[0] ?? "");
};

export const rewriteScheduleConfig = (
  content: string, expression: string, anchor: string | null, cadence: "weekly" | "fortnightly" | null,
) => Either.gen(function* () {
  if (content.includes("'''") || content.includes('"""')) {
    return yield* Either.left(scheduleError("Cannot safely edit a profile containing multiline strings."));
  }

  const withoutCrLf = content.replaceAll("\r\n", "");
  const hasCrLf = withoutCrLf !== content;

  if (withoutCrLf.includes("\r") || (hasCrLf && withoutCrLf.includes("\n"))) {
    return yield* Either.left(scheduleError("Cannot safely edit a profile with mixed line endings."));
  }

  const newline = hasCrLf ? "\r\n" : "\n";
  const expected = yield* parseToml(content);
  const schedule: TomlValue = expected.schedule ?? Object.create(null);

  if (!isScheduleConfigTable(schedule)) return yield* Either.left(scheduleError("Cannot safely edit schedule table."));
  expected.schedule = schedule;
  schedule.schedule = expression;
  delete schedule.anchor;

  if (anchor !== null) schedule.anchor = anchor;
  const policy = expected.policy;
  const cadenceAnchor = cadence === "fortnightly" ? anchor : null;

  if (isScheduleConfigTable(policy)) {
    delete policy.cadence;
    delete policy.cadence_anchor;

    if (cadence !== null) policy.cadence = cadence;

    if (cadenceAnchor !== null) policy.cadence_anchor = cadenceAnchor;
  }

  const scheduleText = `schedule = ${JSON.stringify(expression)}${newline}` + (anchor === null ? "" : `anchor = "${anchor}"${newline}`);
  const policyText = (cadence === null ? "" : `cadence = "${cadence}"${newline}`) + (cadenceAnchor === null ? "" : `cadence_anchor = "${cadenceAnchor}"${newline}`);
  const out: string[] = [];
  const seen = new Set<Section>();
  let section: Section | undefined;

  // TOML comments end at LF or CRLF, not at Unicode line separators.
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

  for (const line of lines) {
    const stripped = strip(line);

    if (stripped.startsWith("[")) {
      const name = header.exec(stripped)?.[1];
      section = name === "schedule" || name === "policy" ? name : undefined;

      if (section !== undefined) {
        if (seen.has(section)) return yield* Either.left(scheduleError("Cannot safely edit repeated profile tables."));
        seen.add(section);
        out.push(line);

        if (!line.endsWith("\n")) out.push(newline);
        out.push(section === "schedule" ? scheduleText : policyText);
        continue;
      }
    }

    const [, indent = "", key] = assignment.exec(line) ?? [];

    const replaces = (section === "schedule" && (key === "schedule" || key === "anchor"))
      || (section === "policy" && (key === "cadence" || key === "cadence_anchor"));

    const preserved = replaces ? keepComment(line, indent) : line;

    if (preserved) out.push(preserved);
  }

  let result = out.join("");

  if (!seen.has("schedule")) {
    result += `${!result || result.endsWith("\n") ? "" : newline}${newline}[schedule]${newline}${scheduleText}`;
  }

  if (content && !content.endsWith("\n") && result.endsWith(newline)) {
    result = result.slice(0, -newline.length);
  }

  const actual = parseToml(result);

  if (Either.isLeft(actual) || containsNaN(expected) || !isDeepStrictEqual(actual.right, expected)) {
    return yield* Either.left(scheduleError("Cannot safely edit this profile representation."));
  }

  return result;
});
