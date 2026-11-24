import { Either } from "effect";
import { isAbsolute } from "node:path";
import { normalize, validatePeriod, type Period } from "../profile/schedule-period.ts";
import { unitNames, type ScheduleRenderInput } from "./schedule-render.ts";

export const launchdLabel = (root: string, profileId: string): string =>
  `no.${unitNames(root, profileId)[0].slice(0, -".service".length)}`;

const xml = (value: string): string => {
  if (/[^\u0020-\u007e\u0080-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
    throw new Error("Invalid character in launchd property list");
  }

  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
};

export const launchdArguments = (command: readonly string[], configured: Period): readonly string[] => {
  const period = Either.getOrThrow(validatePeriod(configured));
  const argv = [...command];

  if (!isAbsolute(argv[0] ?? "")) throw new Error("The executable must be an absolute path");

  if (period.anchor !== null) argv.push("--only-if-due", "--period", Either.getOrThrow(normalize(period)), "--anchor", period.anchor);

  return argv;
};

export const renderLaunchd = (input: ScheduleRenderInput): string => {
  const label = launchdLabel(input.resolvedRoot, input.profileId);
  const period = Either.getOrThrow(validatePeriod(input.period));
  const argv = launchdArguments(input.command, period);
  const [hour, minute] = period.time.split(":").map(Number);
  const calendar = [`<key>Hour</key><integer>${hour}</integer>`, `<key>Minute</key><integer>${minute}</integer>`];
  // Profile weekdays start at Monday=0. launchd uses Sunday=0 (or 7).

  if (period.weekday !== null) calendar.push(`<key>Weekday</key><integer>${(period.weekday + 1) % 7}</integer>`);

  if (period.day_of_month !== null) calendar.push(`<key>Day</key><integer>${period.day_of_month}</integer>`);

  const environment = input.searchPath === undefined ? "" :
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.searchPath)}</string></dict>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>${xml(label)}</string>
<key>WorkingDirectory</key><string>${xml(input.resolvedRoot)}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>Umask</key><integer>63</integer>
${environment}<key>StartCalendarInterval</key><dict>${calendar.join("")}</dict>
</dict>
</plist>
`;
};
